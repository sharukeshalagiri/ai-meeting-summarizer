import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The upload pipeline as jobs (in-process queue), with every repository
 * in memory and every upstream (Whisper, Gemini) scripted. Nothing
 * reaches the network or a database.
 */

const store = vi.hoisted(() => ({
  meeting: null as null | Record<string, unknown>,
  transcript: null as null | { content: string },
  segments: [] as Record<string, unknown>[],
  summary: null as null | { content: string; data: Record<string, unknown> },
  actionItems: [] as unknown[],
  stages: [] as (string | null)[],
  asrFailures: 0,
  asrError: null as null | (() => Error),
  geminiDown: null as null | (() => Error),
  indexed: 0,
  replaceCalls: 0,
}));

vi.mock("../../src/repositories/meeting.repository", () => {
  const row = () => store.meeting as Record<string, unknown>;
  return {
    exists: async (id: string) => store.meeting?.id === id,
    findById: async (id: string) =>
      store.meeting?.id === id
        ? { ...row(), transcript: store.transcript, summary: store.summary, actionItems: store.actionItems }
        : null,
    findProgress: async (id: string) =>
      store.meeting?.id === id
        ? {
            id,
            status: row().status,
            source: row().source,
            processingStage: row().processingStage ?? null,
            processingProgress: row().processingProgress ?? null,
            processingError: row().processingError ?? null,
          }
        : null,
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
      if (data.progress !== undefined) row().processingProgress = data.progress;
      if (data.error !== undefined) row().processingError = data.error;
      if (data.status !== undefined) row().status = data.status;
    },
  };
});

vi.mock("../../src/repositories/transcript.repository", () => ({
  findByMeetingId: async () => store.transcript,
  upsert: async (_id: string, content: string) => {
    store.transcript = { content };
    return store.transcript;
  },
}));

vi.mock("../../src/repositories/segment.repository", () => ({
  findByMeetingId: async () => store.segments,
  countByMeetingId: async () => store.segments.length,
  replaceForMeeting: async (_id: string, segments: Record<string, unknown>[]) => {
    store.replaceCalls++;
    store.segments = segments.map((segment, idx) => ({ ...segment, idx, noiseLabel: null }));
  },
  setNoiseLabels: async (_id: string, labels: { idx: number; label: string }[]) => {
    for (const { idx, label } of labels) {
      const row = store.segments.find((segment) => segment.idx === idx);
      if (row) row.noiseLabel = label;
    }
  },
}));

vi.mock("../../src/repositories/summary.repository", () => ({
  upsert: async (_id: string, content: string, data: Record<string, unknown>) => {
    store.summary = { content, data };
    return store.summary;
  },
}));

vi.mock("../../src/repositories/actionItem.repository", () => ({
  replaceForMeeting: async (_id: string, items: unknown[]) => {
    store.actionItems = items;
    return items.length;
  },
  findByMeetingId: async () => store.actionItems,
}));

vi.mock("../../src/services/speech.service", async () => {
  const { UpstreamError } = await import("../../src/types/errors");
  return {
    transcribeAudioDetailed: async () => {
      if (store.asrFailures > 0) {
        store.asrFailures--;
        throw store.asrError?.() ?? UpstreamError("Could not reach the transcription service.");
      }
      return {
        text: "Ana: ship it Friday. Ben: agreed.",
        durationMs: 4000,
        segments: [
          { text: "Ship it Friday.", startMs: 0, endMs: 2000 },
          { text: "Agreed.", startMs: 2000, endMs: 4000 },
        ],
      };
    },
  };
});

vi.mock("../../src/services/diarization.service", () => ({
  diarizeSegments: async (segments: Record<string, unknown>[]) =>
    segments.map((segment, i) => ({ ...segment, speaker: i % 2 ? "Ben" : "Ana" })),
}));

vi.mock("../../src/services/summary.service", () => ({
  cleanSegments: async (
    segments: { idx: number }[],
    options: { writeNoiseLabels?: (labels: { idx: number; label: string }[]) => Promise<void> }
  ) => {
    if (store.geminiDown) return new Map(); // CLEAN never fails a run
    await options.writeNoiseLabels?.(segments.map((s) => ({ idx: s.idx, label: "substantive" })));
    return new Map();
  },
  generateSummary: async () => {
    if (store.geminiDown) throw store.geminiDown();
    return {
      markdown: "# Legacy",
      structured: { actionItems: [], sentiment: { overall: "neutral" } },
    };
  },
}));

vi.mock("../../src/services/w1-sum.service", () => ({
  resummarize: async (meetingId: string) => {
    if (store.geminiDown) throw store.geminiDown();
    store.summary = { content: "# TL;DR", data: { schemaVersion: 2, pipeline: "v2", meetingId } };
    store.actionItems = [{ task: "Ship it", owner: "Ana" }];
  },
}));

vi.mock("../../src/services/embedding.service", () => ({
  indexMeeting: async () => {
    store.indexed++;
    return store.segments.length;
  },
}));

import { setStorage, storageKeys } from "../../src/lib/storage";
import { LocalStorage } from "../../src/lib/storage/local";
import { toGeminiError } from "../../src/lib/gemini";
import { getQueue } from "../../src/jobs/index";
import type { MemoryQueue } from "../../src/jobs/memoryQueue";
import * as meetingService from "../../src/services/meeting.service";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ams-pipeline-"));
const storage = new LocalStorage(root);
setStorage(storage);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const rateLimited = () => toGeminiError(new Error("429 Too Many Requests: quota"), "Summary failed");

beforeEach(() => {
  store.meeting = { id: "m1", status: "CREATED", source: "UPLOAD", audioPath: "uploads/meetings/a.webm" };
  store.transcript = null;
  store.segments = [];
  store.summary = null;
  store.actionItems = [];
  store.stages = [];
  store.asrFailures = 0;
  store.asrError = null;
  store.geminiDown = null;
  store.indexed = 0;
  store.replaceCalls = 0;
});

/** Every job of the previous test has finished, so tests stay independent. */
afterEach(async () => {
  vi.useRealTimers();
  const queue = (await getQueue()) as MemoryQueue;
  await vi.waitFor(
    () => expect(queue.store.jobs.filter((job) => !["completed", "failed"].includes(job.state))).toEqual([]),
    { timeout: 3000, interval: 5 }
  );
});

/**
 * Advances fake time in 1 s steps, yielding to real I/O (storage writes)
 * between steps, until the meeting reaches `stage`.
 */
const advanceUntilStage = async (stage: string, maxSeconds = 600) => {
  for (let i = 0; i < maxSeconds && store.meeting?.processingStage !== stage; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
  }
  expect(store.meeting?.processingStage).toBe(stage);
};

const stageIs = async (stage: string) =>
  vi.waitFor(() => expect(store.meeting?.processingStage).toBe(stage), { timeout: 3000, interval: 5 });

describe("upload pipeline (jobs)", () => {
  it("runs transcribe -> diarize -> clean -> summarize -> index, stage by stage", async () => {
    const state = await meetingService.startProcessing("m1");
    expect(state).toEqual({ meetingId: "m1", status: "PROCESSING", processingStage: "TRANSCRIBING" });

    await stageIs("DONE");
    await vi.waitFor(() => expect(store.indexed).toBe(1));

    expect(store.stages).toEqual(["TRANSCRIBING", "DIARIZING", "CLEANING", "SUMMARIZING", "DONE"]);
    expect(store.meeting).toMatchObject({ status: "COMPLETED", processingError: null, durationSec: 4 });
    expect(store.segments.map((s) => [s.idx, s.speaker, s.noiseLabel])).toEqual([
      [0, "Ana", "substantive"],
      [1, "Ben", "substantive"],
    ]);
    expect(store.summary?.data.pipeline).toBe("v2");
    // The ASR hand-off artifact is cleaned up once the meeting is done.
    expect(await storage.exists(storageKeys.asr("m1"))).toBe(false);
  });

  it("does not queue a second pipeline while one runs; /summarize then adds nothing", async () => {
    await meetingService.startProcessing("m1");
    const again = await meetingService.startProcessing("m1");
    expect(again.processingStage).toBeTruthy();

    await stageIs("DONE");
    expect(store.stages.filter((s) => s === "TRANSCRIBING")).toHaveLength(1);
  });

  it("POST /transcribe keeps its synchronous answer: the transcript once diarized", async () => {
    const transcript = await meetingService.transcribeMeeting("m1");
    expect(transcript).toEqual({ content: "Ana: ship it Friday. Ben: agreed." });
    await stageIs("DONE");
  });

  it("retries an unreachable ASR with backoff and recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    store.asrFailures = 2;

    await meetingService.startProcessing("m1");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.meeting?.processingError).toMatch(
      /^\[TRANSCRIBING\/ASR_UNREACHABLE\] .* Retrying automatically \(attempt 2 of 4\)\.$/
    );

    await vi.advanceTimersByTimeAsync(15_000); // 1st retry
    await vi.advanceTimersByTimeAsync(30_000); // 2nd retry succeeds
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();

    await stageIs("DONE");
    expect(store.meeting?.status).toBe("COMPLETED");
  });

  it("a Gemini 429 that outlasts the retries fails readably, keeps the transcript, and retry resumes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    store.geminiDown = rateLimited;

    await meetingService.startProcessing("m1");
    await advanceUntilStage("FAILED");
    vi.useRealTimers();

    expect(store.meeting).toMatchObject({
      status: "FAILED",
      processingError:
        "[SUMMARIZING/RATE_LIMITED] The AI service is rate limited or out of quota. Retry later from this page.",
    });
    expect(String(store.meeting?.processingError)).not.toMatch(/Too Many Requests/);
    expect(store.segments).toHaveLength(2);
    expect(store.transcript).not.toBeNull();

    // Quota is back: retry from the page resumes at CLEAN, not ASR.
    store.geminiDown = null;
    const retried = await meetingService.retryProcessing("m1");
    expect(retried.processingStage).toBe("CLEANING");
    await stageIs("DONE");
    expect(store.replaceCalls).toBe(1);
    expect(store.meeting).toMatchObject({ status: "COMPLETED", processingError: null });
  });

  it("a missing recording fails at once, without retries", async () => {
    store.meeting!.audioPath = null;
    await expect(meetingService.startProcessing("m1")).rejects.toThrow(/No audio uploaded/);
    await expect(meetingService.retryProcessing("m1")).rejects.toThrow(/nothing to retry/);
  });

  it("an upload with no speech ends as NO_SPEECH, not FAILED", async () => {
    // Silence: Whisper returns no segments.
    const speech = await import("../../src/services/speech.service");
    const spy = vi
      .spyOn(speech, "transcribeAudioDetailed")
      .mockResolvedValueOnce({ text: "", segments: [], durationMs: 3000, language: null, provider: "local" } as never);

    await meetingService.startProcessing("m1");
    await stageIs("NO_SPEECH");
    expect(store.meeting?.status).toBe("COMPLETED");
    spy.mockRestore();
  });
});
