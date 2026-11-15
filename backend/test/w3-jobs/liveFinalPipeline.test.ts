import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live final pass as jobs (in-process queue): assemble -> transcribe
 * -> diarize (speakers carried from the draft) -> clean -> summarize ->
 * index. Repositories are in memory, ffmpeg/Whisper/Gemini are scripted.
 * Nothing reaches the network or a database.
 */

const store = vi.hoisted(() => ({
  meeting: null as null | Record<string, unknown>,
  transcript: null as null | { content: string },
  segments: [] as Record<string, unknown>[],
  profiles: [] as { id: string; label: string; displayName: string | null; source: string }[],
  corrections: [] as Record<string, unknown>[],
  chunks: [] as Record<string, unknown>[],
  summary: null as null | Record<string, unknown>,
  stages: [] as (string | null)[],
  asrCalls: [] as { path: string; options: unknown }[],
  diarizeCalls: [] as unknown[][],
  /** When set, assembly waits for it (to kill the worker mid-job). */
  assembleGate: null as null | Promise<void>,
  assembleCalls: 0,
  asrDown: false,
  indexed: 0,
  actionItems: [] as { id: string; task: string; status: string; evidence: unknown }[],
}));

vi.mock("../../src/repositories/meeting.repository", () => {
  const row = () => store.meeting as Record<string, unknown>;
  return {
    exists: async (id: string) => store.meeting?.id === id,
    findById: async (id: string) => (store.meeting?.id === id ? { ...row() } : null),
    findProgress: async (id: string) =>
      store.meeting?.id === id
        ? {
            id,
            status: row().status,
            source: "LIVE",
            processingStage: row().processingStage ?? null,
            processingProgress: null,
            processingError: row().processingError ?? null,
          }
        : null,
    setAudioPath: async (_id: string, audioPath: string) => {
      row().audioPath = audioPath;
    },
    updateDuration: async (_id: string, durationSec: number) => {
      row().durationSec = durationSec;
    },
    updateProcessing: async (
      _id: string,
      data: { stage?: string | null; progress?: number | null; error?: string | null; status?: string }
    ) => {
      if (data.stage !== undefined) {
        row().processingStage = data.stage;
        store.stages.push(data.stage);
      }
      if (data.error !== undefined) row().processingError = data.error;
      if (data.status !== undefined) row().status = data.status;
    },
  };
});

vi.mock("../../src/repositories/transcript.repository", () => ({
  findByMeetingId: async () => store.transcript,
  upsert: async (_id: string, content: string) => {
    store.transcript = { content };
  },
}));

vi.mock("../../src/repositories/segment.repository", () => ({
  findByMeetingId: async () => [...store.segments].sort((a, b) => (a.idx as number) - (b.idx as number)),
  countByMeetingId: async () => store.segments.length,
  replaceForMeeting: async (_id: string, segments: Record<string, unknown>[]) => {
    // Like Prisma: idx 0..n-1, only stored columns (no speakerId here).
    store.segments = segments.map(({ speakerId: _drop, ...segment }, idx) => ({
      ...segment,
      idx,
      speakerId: null,
      noiseLabel: null,
    }));
  },
  setNoiseLabels: async () => 0,
}));

vi.mock("../../src/repositories/speakerProfile.repository", () => ({
  assignSegments: async (_id: string, links: { idx: number; speakerId: string }[]) => {
    for (const { idx, speakerId } of links) {
      const row = store.segments.find((segment) => segment.idx === idx);
      if (row) row.speakerId = speakerId;
    }
    return links.length;
  },
}));

vi.mock("../../src/repositories/correction.repository", () => ({
  findByMeetingId: async () => store.corrections,
  record: async (row: Record<string, unknown>) => {
    store.corrections.push(row);
  },
}));

vi.mock("../../src/repositories/liveChunk.repository", () => ({
  findBySession: async () => store.chunks,
}));

vi.mock("../../src/repositories/liveSession.repository", () => ({
  findById: async (id: string) => ({ id, meetingId: "m1", hints: ["Kubernetes"], roster: ["Alice"] }),
}));

vi.mock("../../src/repositories/summary.repository", () => ({
  upsert: async () => undefined,
}));
vi.mock("../../src/repositories/actionItem.repository", () => ({
  replaceForMeeting: async () => 0,
  findByMeetingId: async () => store.actionItems,
  updateEvidence: async (id: string, evidence: unknown) => {
    const item = store.actionItems.find((row) => row.id === id);
    if (item) item.evidence = evidence;
  },
}));

vi.mock("../../src/services/speech.service", async () => {
  const { UpstreamError } = await import("../../src/types/errors");
  return {
    transcribeAudioDetailed: async (filePath: string, _offset: number, options: unknown) => {
      store.asrCalls.push({ path: filePath, options });
      if (store.asrDown) throw UpstreamError("Could not reach the transcription service.");
      // The whole recording, cut differently from the live draft.
      return {
        text: "Hello all. Ship it Friday. Agreed. Late thought.",
        durationMs: 12_000,
        segments: [
          { text: "Hello all.", startMs: 200, endMs: 1800, channel: "mic" },
          { text: "Ship it Friday.", startMs: 2100, endMs: 5600, channel: "remote" },
          { text: "Agreed.", startMs: 6100, endMs: 7900, channel: "remote" },
          // No draft segment here (the chunk failed live).
          { text: "Late thought.", startMs: 10_000, endMs: 11_500, channel: "remote" },
        ],
      };
    },
  };
});

vi.mock("../../src/services/diarization.service", () => ({
  diarizeSegments: async (segments: Record<string, unknown>[], context: unknown) => {
    store.diarizeCalls.push([segments, context]);
    return segments.map((segment) => ({ ...segment, speaker: "Speaker 4", speakerId: "p-4" }));
  },
}));

vi.mock("../../src/services/summary.service", () => ({
  cleanSegments: async () => new Map(),
  generateSummary: async () => ({ markdown: "", structured: { actionItems: [], sentiment: { overall: "neutral" } } }),
}));

vi.mock("../../src/services/w1-sum.service", () => ({
  resummarize: async () => {
    store.summary = { pipeline: "v2" };
  },
}));

vi.mock("../../src/services/embedding.service", () => ({
  indexMeeting: async () => {
    store.indexed++;
    return 0;
  },
}));

import { setStorage, storageKeys } from "../../src/lib/storage";
import { LocalStorage } from "../../src/lib/storage/local";
import { QUEUE_DEFINITIONS } from "../../src/jobs/definitions";
import { getQueue, stopJobs } from "../../src/jobs/index";
import { setAssembleDeps, assemble } from "../../src/jobs/live";
import { MemoryQueue } from "../../src/jobs/memoryQueue";
import { registerWorkers } from "../../src/jobs/worker";
import * as meetingService from "../../src/services/meeting.service";
import type { PassThrough } from "stream";
import { spawnSync } from "child_process";
import type { AssembleDeps } from "../../src/jobs/assemble";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ams-livefinal-"));
const storage = new LocalStorage(root);
setStorage(storage);

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;

/** Scripted ffmpeg: 1 s of silence per chunk, collected as the "encoding". */
const scriptedDeps: AssembleDeps = {
  exists: async () => true,
  decode: async (_file, channels) => {
    store.assembleCalls++;
    if (store.assembleGate) await store.assembleGate;
    return Buffer.alloc(16_000 * channels * 2);
  },
  encode: async (input: PassThrough, _channels, target, key) => {
    const parts: Buffer[] = [];
    for await (const part of input) parts.push(part as Buffer);
    await target.put(key, Buffer.concat(parts));
  },
};
setAssembleDeps(scriptedDeps);

afterAll(async () => {
  setAssembleDeps(null);
  await stopJobs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The live draft as /end leaves it: sparse idx, renamed speakers. */
const draft = () => [
  { idx: 0, speaker: "Me", text: "hello all", startMs: 0, endMs: 2000, channel: "mic", speakerId: "p-mic", noiseLabel: null },
  // "Speaker 2" was renamed to "Alice" (profile p-2, source MANUAL).
  { idx: 1000, speaker: "Alice", text: "ship it friday", startMs: 2000, endMs: 6000, channel: "remote", speakerId: "p-2", noiseLabel: null },
  // seq 2, segment 1 (chunks here are not 1:1 with the ASR fake's timing).
  { idx: 2001, speaker: "Speaker 3", text: "agreed", startMs: 6000, endMs: 8000, channel: "remote", speakerId: "p-3", noiseLabel: null },
];

const RENAME = {
  meetingId: "m1",
  kind: "SPEAKER",
  targetId: "p-2",
  before: { speaker: "Speaker 2", label: "Speaker 2", idx: [1000] },
  after: { speaker: "Alice", label: "Speaker 2", idx: [1000], via: "manual" },
};

beforeEach(() => {
  store.meeting = { id: "m1", status: "TRANSCRIBED", source: "LIVE", audioPath: null, processingStage: null };
  store.transcript = { content: "hello all ship it friday agreed" };
  store.segments = draft();
  store.profiles = [{ id: "p-2", label: "Speaker 2", displayName: "Alice", source: "MANUAL" }];
  store.corrections = [structuredClone(RENAME)];
  store.chunks = [0, 1, 2, 4].map((seq) => ({
    seq,
    path: `uploads/live/c${seq}.webm`,
    startOffsetMs: seq * 2000,
    durationMs: 2000,
    channelLayout: "stereo-mic-left",
    status: seq === 4 ? "FAILED" : "TRANSCRIBED",
  }));
  store.summary = null;
  store.stages = [];
  store.asrCalls = [];
  store.diarizeCalls = [];
  store.assembleGate = null;
  store.assembleCalls = 0;
  store.asrDown = false;
  store.indexed = 0;
  store.actionItems = [];
});

afterEach(async () => {
  const queue = (await getQueue()) as MemoryQueue;
  await vi.waitFor(
    () => expect(queue.store.jobs.filter((job) => !["completed", "failed"].includes(job.state))).toEqual([]),
    { timeout: 3000, interval: 5 }
  );
});

const stageIs = (stage: string) =>
  vi.waitFor(() => expect(store.meeting?.processingStage).toBe(stage), { timeout: 3000, interval: 5 });

describe("live final pass", () => {
  it("assembles, re-transcribes and replaces the draft, keeping renames and corrections", async () => {
    const state = await meetingService.startLiveFinal("m1", "s1", "live-final");
    expect(state.processingStage).toBe("ASSEMBLING");

    await stageIs("DONE");
    expect(store.stages).toEqual(["ASSEMBLING", "TRANSCRIBING", "DIARIZING", "CLEANING", "SUMMARIZING", "DONE"]);

    // The recording and its manifest; the meeting now has audio.
    const key = storageKeys.liveRecording("m1");
    expect(store.meeting!.audioPath).toBe(storage.relativePath(key));
    const manifest = JSON.parse((await storage.get(storageKeys.liveManifest("m1")))!.toString());
    expect(manifest).toMatchObject({ channelLayout: "stereo-mic-left", missingSeqs: [3], durationMs: 10_000 });
    expect(manifest.silence).toEqual([{ fromMs: 6000, toMs: 8000 }]);

    // Whisper ran on the recording, with the session's layout and hints.
    expect(store.asrCalls).toHaveLength(1);
    expect(store.asrCalls[0].options).toMatchObject({
      meetingId: "m1",
      channelLayout: "stereo-mic-left",
      hints: ["Kubernetes"],
      roster: ["Alice"],
    });

    // Final segments replace the draft; speakers come from the draft by
    // overlap (the rename "Alice" included), only the uncovered one is
    // diarized against the meeting's profiles.
    expect(store.segments.map((s) => [s.idx, s.text, s.speaker, s.speakerId])).toEqual([
      [0, "Hello all.", "Me", "p-mic"],
      [1, "Ship it Friday.", "Alice", "p-2"],
      [2, "Agreed.", "Speaker 3", "p-3"],
      [3, "Late thought.", "Speaker 4", "p-4"],
    ]);
    expect(store.diarizeCalls).toHaveLength(1);
    expect((store.diarizeCalls[0][0] as { text: string }[]).map((s) => s.text)).toEqual(["Late thought."]);
    expect(store.diarizeCalls[0][1]).toMatchObject({ meetingId: "m1", offsetMs: 0, channelLayout: "stereo-mic-left" });

    // Corrections are untouched; the MANUAL profile is never rewritten.
    expect(store.corrections).toEqual([RENAME]);
    expect(store.profiles[0]).toMatchObject({ displayName: "Alice", source: "MANUAL" });

    expect(store.transcript?.content).toContain("Late thought.");
    expect(store.meeting).toMatchObject({ status: "COMPLETED", durationSec: 12 });
    await vi.waitFor(() => expect(store.indexed).toBe(1));
  });

  it("keeps the live draft (with a note) when Whisper stays down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      store.asrDown = true;
      await meetingService.startLiveFinal("m1", "s1", "live-final");

      // Until DONE and the index job after it ran (no job left on fake timers).
      for (let i = 0; i < 600 && !(store.meeting?.processingStage === "DONE" && store.indexed > 0); i++) {
        await vi.advanceTimersByTimeAsync(1000);
        for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      vi.useRealTimers();
    }

    expect(store.meeting!.processingStage).toBe("DONE");
    expect(store.meeting!.status).toBe("COMPLETED");
    // Transcribe was retried (1 + 3 retries), then the draft was summarized.
    expect(store.asrCalls).toHaveLength(4);
    expect(store.stages).toContain("CLEANING");
    expect(store.stages).not.toContain("FAILED");
    expect(store.segments.map((s) => s.idx)).toEqual([0, 1000, 2001]);
    expect(store.segments[1].speaker).toBe("Alice");
    expect(store.summary).toEqual({ pipeline: "v2" });
  });

  it("a worker killed mid-assembly: the next process picks the job up and finishes", async () => {
    const { MemoryStore } = await import("../../src/jobs/memoryQueue");
    const shared = new MemoryStore();
    let now = Date.now();

    const boot = async () => {
      const queue = new MemoryQueue({ store: shared, now: () => now });
      for (const definition of QUEUE_DEFINITIONS) await queue.createQueue(definition);
      await registerWorkers(queue, { schedules: false });
      return queue;
    };

    // Process A takes the assemble job and dies inside it.
    // Never released: a killed process never resumes (if it did, its
    // late write would race the next test's recording).
    store.assembleGate = new Promise<void>(() => undefined);
    const a = await boot();
    const id = await a.send(
      "live-assemble",
      { meetingId: "m1", origin: "live-final", sessionId: "s1" },
      { singletonKey: "m1" }
    );
    await vi.waitFor(() => expect(store.assembleCalls).toBe(1));
    await a.stop();
    expect(a.job(id!)?.state).toBe("active");

    // Process B starts; once A's attempt has expired it retries the job.
    store.assembleGate = null;
    const b = await boot();
    now += 31 * 60 * 1000; // live-assemble expires after 30 min
    b.runDue(); // expired: back to "retry" after its 15 s backoff
    expect(shared.jobs.find((job) => job.id === id)?.state).toBe("retry");
    now += 20 * 1000;
    b.runDue();

    await stageIs("DONE");
    expect(store.segments.map((s) => s.speaker)).toEqual(["Me", "Alice", "Speaker 3", "Speaker 4"]);
    expect(shared.jobs.find((job) => job.id === id)).toMatchObject({ state: "completed", retryCount: 1 });

    await b.drain();
    await b.stop();
  });

  it("the assemble handler on its own keeps the draft when no chunk audio exists", async () => {
    store.chunks = [];
    await assemble({
      id: "j",
      name: "live-assemble",
      data: { meetingId: "m1", origin: "live-final", sessionId: "s1" },
      retryCount: 0,
      retryLimit: 2,
    });
    expect(store.meeting!.audioPath).toBeNull();
    expect(store.meeting!.processingStage).toBe("CLEANING");
    expect(store.meeting!.processingError).toMatch(/live transcript/);
    await stageIs("DONE");
  });

  it.skipIf(!hasFfmpeg)("end to end with real ffmpeg: generated stereo chunks -> playable recording -> DONE", async () => {
    const dir = fs.mkdtempSync(path.join(root, "e2e-"));
    // seq 0, 1 and 3 (2 is missing): 2 s stereo tones, left = mic tone.
    store.chunks = [0, 1, 3].map((seq) => {
      const file = path.join(dir, `${seq}.ogg`);
      const made = spawnSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `sine=frequency=${300 + seq * 100}:sample_rate=48000:duration=2`,
        "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2",
        "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]", "-map", "[a]",
        "-c:a", "libopus", file,
      ]);
      if (made.status !== 0) throw new Error(made.stderr.toString());
      return { seq, path: file, startOffsetMs: seq * 2000, durationMs: 2000, channelLayout: "stereo-mic-left", status: "TRANSCRIBED" };
    });

    setAssembleDeps(null); // the real ffmpeg decoder and Opus encoder
    try {
      await meetingService.startLiveFinal("m1", "s1", "live-final");
      await vi.waitFor(() => expect(store.meeting?.processingStage).toBe("DONE"), { timeout: 20_000, interval: 20 });
    } finally {
      setAssembleDeps(scriptedDeps);
    }

    const recording = path.resolve(store.meeting!.audioPath as string);
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=channels,codec_name:format=duration",
      "-of", "json", recording,
    ]);
    // The final pass used the recording (no fallback note), and ffprobe
    // could read it; the messages say why if not.
    expect(store.meeting!.processingError, `stages: ${store.stages.join(" > ")}`).toBeNull();
    expect(probe.status, `ffprobe: ${probe.stderr?.toString()} (${recording})`).toBe(0);
    const info = JSON.parse(probe.stdout.toString());
    expect(info.streams[0]).toMatchObject({ codec_name: "opus", channels: 2 });
    expect(Number(info.format.duration)).toBeGreaterThan(7.8);
    expect(Number(info.format.duration)).toBeLessThan(8.2);

    // GET /meetings/:id/audio resolves the same file for the live meeting.
    expect(await meetingService.getAudioFile("m1")).toBe(recording);
    expect(store.asrCalls[0].path).toBe(store.meeting!.audioPath);
    expect(store.segments.map((s) => s.speaker)).toEqual(["Me", "Alice", "Speaker 3", "Speaker 4"]);
    expect(store.corrections).toEqual([RENAME]);
    await vi.waitFor(() => expect(store.indexed).toBe(1));
  }, 30_000);

  it("re-points a kept action item's evidence (draft idx 2001) to the final segment at the same time", async () => {
    store.actionItems = [
      {
        id: "a1",
        task: "Confirm Friday",
        status: "ACCEPTED",
        evidence: [
          // No startMs: the draft segment 2001's start (6000 ms) is used.
          { idx: 2001, speaker: "Speaker 3", quote: "agreed" },
          // With startMs: that moment is used.
          { idx: 1000, speaker: "Alice", quote: "ship it", startMs: 2500 },
        ],
      },
    ];

    await meetingService.startLiveFinal("m1", "s1", "live-final");
    await stageIs("DONE");

    // Final segments: 0 "Hello all." 200-1800, 1 "Ship it Friday." 2100-5600,
    // 2 "Agreed." 6100-7900, 3 "Late thought." 10000-11500.
    expect(store.actionItems[0]).toMatchObject({
      status: "ACCEPTED",
      evidence: [
        { idx: 2, speaker: "Speaker 3", quote: "agreed", startMs: 6000 },
        { idx: 1, speaker: "Alice", quote: "ship it", startMs: 2500 },
      ],
    });
    const byIdx = new Map(store.segments.map((segment) => [segment.idx, segment.text]));
    expect(byIdx.get(2)).toBe("Agreed.");
    expect(byIdx.get(1)).toBe("Ship it Friday.");
  });
});
