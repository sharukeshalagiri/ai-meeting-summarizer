import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { PassThrough } from "stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  assembleRecording,
  decodeChunk,
  layoutFor,
  missingSeqs,
  planSlots,
  SAMPLE_RATE,
  type AssembleDeps,
  type ChunkSource,
} from "../../src/jobs/assemble";
import { carrySpeakers, remapEvidence, segmentAt } from "../../src/jobs/liveFinal";
import { LocalStorage } from "../../src/lib/storage/local";

/**
 * Live assembly (chunks -> one recording) and the speaker carry-over of
 * the final pass. Pure planning and a scripted decoder/encoder run
 * everywhere; the real-ffmpeg check runs where ffmpeg is installed
 * (generated sine-tone chunks, no network, no database).
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ams-assemble-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const chunk = (seq: number, extra: Partial<ChunkSource> = {}): ChunkSource => ({
  seq,
  path: `chunk-${seq}`,
  startOffsetMs: seq * 1000,
  durationMs: 1000,
  channelLayout: "stereo-mic-left",
  ...extra,
});

describe("planning", () => {
  it("places chunks at their offsets, cuts overlaps, ignores empty ones", () => {
    const slots = planSlots([
      chunk(1, { startOffsetMs: 900 }),
      chunk(0),
      chunk(3, { durationMs: 0 }),
    ]);
    expect(slots.map((s) => [s.seq, s.startMs, s.lengthMs])).toEqual([
      [0, 0, 900],
      [1, 900, 1000],
    ]);
  });

  it("lists missing seqs and picks mono when any chunk is mono", () => {
    expect(missingSeqs([chunk(0), chunk(3)])).toEqual([1, 2]);
    expect(layoutFor([chunk(0), chunk(1)])).toBe("stereo-mic-left");
    expect(layoutFor([chunk(0), chunk(1, { channelLayout: "mono" })])).toBe("mono");
  });
});

/** Scripted ffmpeg: each chunk decodes to frames filled with its seq + 1. */
const scripted = (options: { undecodable?: number[]; gone?: number[] } = {}) => {
  let output = Buffer.alloc(0);
  const deps: AssembleDeps = {
    exists: async (file) => !options.gone?.includes(Number(file.split("-")[1])),
    decode: async (file, channels) => {
      const seq = Number(file.split("-")[1]);
      if (options.undecodable?.includes(seq)) throw new Error("Invalid data found");
      // 1 s of audio plus 20 ms of encoder padding, which must be trimmed.
      const samples = Math.round(SAMPLE_RATE * 1.02);
      const buffer = Buffer.alloc(samples * channels * 2);
      for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(seq + 1, i);
      return buffer;
    },
    encode: async (input: PassThrough) => {
      const parts: Buffer[] = [];
      for await (const part of input) parts.push(part as Buffer);
      output = Buffer.concat(parts);
    },
  };
  return { deps, output: () => output };
};

/** The value of the first sample of each second of interleaved PCM. */
const perSecond = (pcm: Buffer, channels: number) => {
  const second = SAMPLE_RATE * channels * 2;
  const values: number[] = [];
  for (let at = 0; at < pcm.length; at += second) values.push(pcm.readInt16LE(at));
  return values;
};

describe("assembleRecording (scripted ffmpeg)", () => {
  const storage = new LocalStorage(root);

  it("a missing seq becomes silence of its length, not a shift", async () => {
    const run = scripted();
    const manifest = await assembleRecording([chunk(0), chunk(2)], storage, "r/a.ogg", run.deps);

    expect(manifest).toMatchObject({
      channelLayout: "stereo-mic-left",
      durationMs: 3000,
      missingSeqs: [1],
      skipped: [],
      silence: [{ fromMs: 1000, toMs: 2000 }],
    });
    expect(manifest!.included.map((c) => c.seq)).toEqual([0, 2]);
    // Exactly 3 s of stereo: chunk 0, silence, chunk 2 (padding trimmed).
    expect(run.output().length).toBe(3 * SAMPLE_RATE * 2 * 2);
    expect(perSecond(run.output(), 2)).toEqual([1, 0, 3]);
  });

  it("a chunk whose file is gone or will not decode stays silent", async () => {
    const run = scripted({ undecodable: [1], gone: [2] });
    const manifest = await assembleRecording(
      [chunk(0), chunk(1), chunk(2), chunk(3)],
      storage,
      "r/b.ogg",
      run.deps
    );

    expect(manifest!.skipped).toEqual([
      { seq: 1, reason: "undecodable" },
      { seq: 2, reason: "missing" },
    ]);
    expect(perSecond(run.output(), 2)).toEqual([1, 0, 0, 4]);
    expect(manifest!.silence).toEqual([{ fromMs: 1000, toMs: 3000 }]);
  });

  it("goes mono when a chunk is mono, and returns null with no usable audio", async () => {
    const mono = scripted();
    const manifest = await assembleRecording(
      [chunk(0), chunk(1, { channelLayout: "mono" })],
      storage,
      "r/c.ogg",
      mono.deps
    );
    expect(manifest!.channelLayout).toBe("mono");
    expect(mono.output().length).toBe(2 * SAMPLE_RATE * 2);

    const none = scripted({ gone: [0, 1] });
    expect(await assembleRecording([chunk(0), chunk(1)], storage, "r/d.ogg", none.deps)).toBeNull();
    expect(await assembleRecording([], storage, "r/e.ogg", none.deps)).toBeNull();
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;

/** A stereo Opus/Ogg chunk: a tone on the left (mic) only. */
const toneChunk = (file: string, seconds: number, hz: number) => {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${seconds}`,
    "-f", "lavfi", "-i", `anullsrc=channel_layout=mono:sample_rate=48000`,
    "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]",
    "-map", "[a]", "-t", String(seconds),
    "-c:a", "libopus", "-b:a", "64k", file,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
};

const rms = (pcm: Buffer, channel: number, from: number, to: number) => {
  let sum = 0;
  let n = 0;
  for (let s = from; s < to; s++) {
    const v = pcm.readInt16LE((s * 2 + channel) * 2);
    sum += v * v;
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
};

describe.skipIf(!hasFfmpeg)("assembleRecording (real ffmpeg, generated tones)", () => {
  it("joins stereo chunks with a missing seq, keeping left = mic and the timeline", async () => {
    const dir = fs.mkdtempSync(path.join(root, "tones-"));
    toneChunk(path.join(dir, "0.ogg"), 2, 440);
    toneChunk(path.join(dir, "2.ogg"), 2, 660);
    fs.writeFileSync(path.join(dir, "3.ogg"), "not audio");

    const storage = new LocalStorage(path.join(dir, "store"));
    const manifest = await assembleRecording(
      [
        chunk(0, { path: path.join(dir, "0.ogg"), startOffsetMs: 0, durationMs: 2000 }),
        chunk(2, { path: path.join(dir, "2.ogg"), startOffsetMs: 4000, durationMs: 2000 }),
        chunk(3, { path: path.join(dir, "3.ogg"), startOffsetMs: 6000, durationMs: 2000 }),
      ],
      storage,
      "recordings/m/live.ogg"
    );

    expect(manifest).toMatchObject({
      channelLayout: "stereo-mic-left",
      durationMs: 6000,
      missingSeqs: [1],
      skipped: [{ seq: 3, reason: "undecodable" }],
      silence: [{ fromMs: 2000, toMs: 4000 }],
    });

    const pcm = await decodeChunk(storage.localPath("recordings/m/live.ogg"), 2);
    const seconds = pcm.length / (SAMPLE_RATE * 2 * 2);
    expect(seconds).toBeGreaterThan(5.9);
    expect(seconds).toBeLessThan(6.1);

    const sec = (s: number) => s * SAMPLE_RATE;
    // Left (mic) has the tones where the chunks are; right stays silent.
    expect(rms(pcm, 0, sec(0.5), sec(1.5))).toBeGreaterThan(1000);
    expect(rms(pcm, 1, sec(0.5), sec(1.5))).toBeLessThan(100);
    // The missing seq is silence on both channels...
    expect(rms(pcm, 0, sec(2.5), sec(3.5))).toBeLessThan(100);
    // ...and chunk 2 still starts at 4 s.
    expect(rms(pcm, 0, sec(4.5), sec(5.5))).toBeGreaterThan(1000);
  }, 30_000);
});

describe("carrySpeakers", () => {
  const draft = [
    { speaker: "You", startMs: 0, endMs: 2000, channel: "mic", speakerId: "p-mic" },
    { speaker: "Alice", startMs: 0, endMs: 3000, channel: "remote", speakerId: "p-2" },
    { speaker: "Speaker 3", startMs: 3000, endMs: 6000, channel: "remote", speakerId: "p-3" },
  ];

  it("takes the speaker of the most-overlapping draft segment on the same channel", () => {
    const { segments, uncovered } = carrySpeakers(
      [
        { text: "hi", startMs: 100, endMs: 1500, channel: "mic" },
        { text: "a", startMs: 500, endMs: 2800, channel: "remote" },
        { text: "b", startMs: 2600, endMs: 5000, channel: "remote" },
        { text: "c", startMs: 9000, endMs: 9500, channel: "remote" },
      ],
      draft
    );

    expect(segments.map((s) => [s.speaker, s.speakerId ?? null])).toEqual([
      ["You", "p-mic"],
      ["Alice", "p-2"],
      ["Speaker 3", "p-3"],
      ["", null],
    ]);
    expect(uncovered).toEqual([3]);
  });

  it("does not inherit from a sliver of overlap", () => {
    const { uncovered } = carrySpeakers(
      [{ text: "x", startMs: 5900, endMs: 9000, channel: "remote" }],
      draft
    );
    expect(uncovered).toEqual([0]);
  });
});

describe("remapEvidence", () => {
  const finals = [
    { idx: 0, startMs: 0, endMs: 1000 },
    { idx: 1, startMs: 1200, endMs: 3000 },
  ];

  it("finds the containing segment, else the nearest", () => {
    expect(segmentAt(finals, 1500)?.idx).toBe(1);
    expect(segmentAt(finals, 1050)?.idx).toBe(0);
    expect(segmentAt(finals, 9000)?.idx).toBe(1);
    expect(segmentAt([], 10)).toBeNull();
  });

  it("re-points by the entry's startMs, else the draft segment's, and leaves unknown moments", () => {
    const draft = new Map([[2001, 1300]]);
    expect(
      remapEvidence(
        [{ idx: 2001, quote: "q" }, { idx: 5, startMs: 100 }, { idx: 7000 }, "junk"],
        draft,
        finals
      )
    ).toEqual([
      { idx: 1, quote: "q", startMs: 1300 },
      { idx: 0, startMs: 100 },
      { idx: 7000 },
      "junk",
    ]);
  });

  it("returns null when nothing changes or there is no evidence", () => {
    expect(remapEvidence([{ idx: 0, startMs: 10 }], new Map(), finals)).toBeNull();
    expect(remapEvidence(null, new Map(), finals)).toBeNull();
    expect(remapEvidence([{ idx: 3, startMs: 10 }], new Map(), [])).toBeNull();
  });
});
