import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { PassThrough, type Writable } from "stream";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import type { Storage } from "../lib/storage";
import type { ChannelLayout } from "../types/capture";

const log = logger.child({ module: "jobs.assemble" });

/**
 * Live assembly: a session's LiveChunks -> one recording.
 *
 * Every chunk is decoded on its own (each is a self-contained Opus file,
 * docs/CAPTURE_CONTRACT.md) to 16 kHz signed 16-bit PCM and written at
 * its startOffsetMs on one timeline, so the assembled recording keeps
 * the exact timestamps the live draft's segments use. That is what lets
 * the final pass carry speakers over from the draft by time overlap.
 *
 * - Gaps (a missing seq, a chunk whose file is gone or will not decode,
 *   or the recorder simply skipping time) become **silence of the same
 *   length**, never a shift of everything after them.
 * - Overlapping chunks: a chunk is cut where the next one starts.
 * - Stereo (left = mic, right = others) is kept when every chunk is
 *   `stereo-mic-left`; if any chunk is mono the whole recording is
 *   mono (a mono chunk has no mic/others split to put on the channels).
 * - The PCM is streamed through one encoder (Opus in Ogg), so memory
 *   holds one decoded chunk at a time (~2 MB for 30 s of stereo).
 *
 * 16 kHz is what Whisper resamples to anyway; Opus at 32 kb/s keeps a
 * one-hour meeting around 15 MB.
 */

export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

/** Gaps shorter than this are encoder padding, not missing audio. */
const REPORTED_GAP_MS = 250;

export interface ChunkSource {
  seq: number;
  path: string;
  startOffsetMs: number;
  durationMs: number;
  channelLayout: string;
}

export interface AssemblyManifest {
  version: 1;
  channelLayout: ChannelLayout;
  sampleRate: number;
  durationMs: number;
  /** Chunks whose audio is in the recording, at these positions. */
  included: { seq: number; startMs: number; durationMs: number }[];
  /** Chunk rows whose audio could not be used; their span is silence. */
  skipped: { seq: number; reason: "missing" | "undecodable" | "empty" }[];
  /** seq numbers below the highest one that have no LiveChunk row. */
  missingSeqs: number[];
  /** Silent spans in the timeline (gaps and skipped chunks). */
  silence: { fromMs: number; toMs: number }[];
}

export interface Slot {
  seq: number;
  path: string;
  startMs: number;
  /** Length on the timeline (cut at the next chunk's start on overlap). */
  lengthMs: number;
}

/** Layout of the assembled recording: stereo only if every chunk is. */
export const layoutFor = (chunks: Pick<ChunkSource, "channelLayout">[]): ChannelLayout =>
  chunks.length > 0 && chunks.every((chunk) => chunk.channelLayout === "stereo-mic-left")
    ? "stereo-mic-left"
    : "mono";

/** Where each chunk goes on the timeline (pure). */
export const planSlots = (chunks: ChunkSource[]): Slot[] => {
  const ordered = [...chunks]
    .filter((chunk) => chunk.durationMs > 0 && chunk.startOffsetMs >= 0)
    .sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.seq - b.seq);

  return ordered.map((chunk, i) => {
    const next = ordered[i + 1];
    const end = chunk.startOffsetMs + chunk.durationMs;
    const cut = next ? Math.min(end, next.startOffsetMs) : end;

    return {
      seq: chunk.seq,
      path: chunk.path,
      startMs: chunk.startOffsetMs,
      lengthMs: Math.max(0, cut - chunk.startOffsetMs),
    };
  });
};

/** seq numbers in 0..max that have no row (pure). */
export const missingSeqs = (chunks: Pick<ChunkSource, "seq">[]): number[] => {
  if (chunks.length === 0) return [];
  const present = new Set(chunks.map((chunk) => chunk.seq));
  const max = Math.max(...present);
  const missing: number[] = [];
  for (let seq = 0; seq <= max; seq++) if (!present.has(seq)) missing.push(seq);
  return missing;
};

const msToSamples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000);

/** Runs ffmpeg and collects stdout; rejects on a non-zero exit. */
const runFfmpeg = (args: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(env.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split("\n").pop() ?? ""}`))
    );
  });

/** One chunk as raw PCM at the assembly format. */
export const decodeChunk = (filePath: string, channels: number): Promise<Buffer> =>
  runFfmpeg([
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-vn",
    "-ac", String(channels),
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    "pipe:1",
  ]);

const write = (stream: Writable, data: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    if (stream.write(data)) return resolve();
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });

const SILENCE_BLOCK = Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE * 2); // 1 s, stereo

const writeSilence = async (stream: Writable, bytes: number): Promise<void> => {
  let left = bytes;
  while (left > 0) {
    const size = Math.min(left, SILENCE_BLOCK.length);
    await write(stream, SILENCE_BLOCK.subarray(0, size));
    left -= size;
  }
};

export interface AssembleDeps {
  decode: (filePath: string, channels: number) => Promise<Buffer>;
  /** Encodes PCM from `input` and stores it under `key`. */
  encode: (input: PassThrough, channels: number, storage: Storage, key: string) => Promise<void>;
  exists: (filePath: string) => Promise<boolean>;
}

/** Opus in Ogg via one ffmpeg process, written atomically through Storage. */
const encodeOpus: AssembleDeps["encode"] = async (input, channels, storage, key) => {
  const child = spawn(
    env.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(channels),
      "-i", "pipe:0",
      "-c:a", "libopus",
      "-b:a", channels === 2 ? "32k" : "24k",
      "-application", "voip",
      "-f", "ogg",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-2000);
  });

  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg encoder exited with ${code}: ${stderr.trim().split("\n").pop() ?? ""}`))
    );
  });
  // A failed spawn must not leave the stdin pipe throwing EPIPE unhandled.
  child.stdin.on("error", () => undefined);
  input.pipe(child.stdin);

  await Promise.all([storage.putStream(key, child.stdout), exited]);
};

const fileExists = async (filePath: string) => {
  try {
    await fs.access(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
};

export const defaultAssembleDeps: AssembleDeps = {
  decode: (filePath, channels) => decodeChunk(path.resolve(filePath), channels),
  encode: encodeOpus,
  exists: fileExists,
};

/**
 * Assembles the chunks into `key`. Returns null when no chunk had usable
 * audio (nothing is stored then). Re-running it rewrites the same key,
 * so a retried job is idempotent.
 */
export const assembleRecording = async (
  chunks: ChunkSource[],
  storage: Storage,
  key: string,
  deps: AssembleDeps = defaultAssembleDeps
): Promise<AssemblyManifest | null> => {
  const channelLayout = layoutFor(chunks);
  const channels = channelLayout === "stereo-mic-left" ? 2 : 1;
  const frameBytes = channels * BYTES_PER_SAMPLE;
  const slots = planSlots(chunks);

  const manifest: AssemblyManifest = {
    version: 1,
    channelLayout,
    sampleRate: SAMPLE_RATE,
    durationMs: 0,
    included: [],
    skipped: [],
    missingSeqs: missingSeqs(chunks),
    silence: [],
  };

  // Decode first, so a session where nothing decodes stores nothing.
  // Each decoded chunk is written as soon as the encoder takes it.
  const pcm = new PassThrough({ highWaterMark: 1 << 20 });
  let encoding: Promise<void> | null = null;
  let cursorMs = 0;

  const ensureEncoder = () => {
    encoding ??= deps.encode(pcm, channels, storage, key);
    // Surfaced by the await below; never an unhandled rejection meanwhile.
    encoding.catch(() => undefined);
  };

  try {
    for (const slot of slots) {
      if (slot.lengthMs <= 0) continue;

      let audio: Buffer | null = null;

      if (!(await deps.exists(slot.path))) {
        manifest.skipped.push({ seq: slot.seq, reason: "missing" });
      } else {
        try {
          audio = await deps.decode(slot.path, channels);
          if (audio.length === 0) {
            manifest.skipped.push({ seq: slot.seq, reason: "empty" });
            audio = null;
          }
        } catch (error) {
          log.warn("Chunk could not be decoded; its span stays silent", {
            seq: slot.seq,
            reason: error instanceof Error ? error.message : String(error),
          });
          manifest.skipped.push({ seq: slot.seq, reason: "undecodable" });
        }
      }

      if (!audio) continue;

      ensureEncoder();

      if (slot.startMs - cursorMs >= REPORTED_GAP_MS) {
        manifest.silence.push({ fromMs: cursorMs, toMs: slot.startMs });
      }

      const gapBytes = (msToSamples(slot.startMs) - msToSamples(cursorMs)) * frameBytes;
      if (gapBytes > 0) await writeSilence(pcm, gapBytes);

      // Exactly the slot's length: decoders and encoders pad by a few
      // ms, and drift would add up over a long meeting.
      const slotBytes = msToSamples(slot.lengthMs) * frameBytes;
      const body = audio.subarray(0, Math.min(audio.length - (audio.length % frameBytes), slotBytes));
      await write(pcm, body);
      if (body.length < slotBytes) await writeSilence(pcm, slotBytes - body.length);

      manifest.included.push({ seq: slot.seq, startMs: slot.startMs, durationMs: slot.lengthMs });
      cursorMs = Math.max(cursorMs, slot.startMs + slot.lengthMs);
    }
  } catch (error) {
    pcm.destroy();
    if (encoding) await (encoding as Promise<void>).catch(() => undefined);
    throw error;
  }

  pcm.end();

  if (!encoding) return null;
  await encoding;

  manifest.durationMs = cursorMs;
  return manifest;
};
