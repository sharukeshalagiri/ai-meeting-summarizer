import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import {
  PROCESSING_ERRORS,
  summaryJob,
} from "../../src/services/meeting.service";

/**
 * POST /summarize runs the summary in the background (in-process) and
 * answers at once; the v2 pipeline falls back to the legacy summarizer.
 * Repositories are in-memory fakes; the v2 pipeline (w1-sum resummarize)
 * and the legacy Gemini summarizer are stubbed, so nothing reaches Gemini.
 */

const store = vi.hoisted(() => ({
  meeting: null as null | Record<string, unknown>,
  transcript: null as null | { content: string },
  summary: null as null | { content: string; data: Record<string, unknown> },
  actionItems: [] as unknown[],
  processingWrites: [] as Record<string, unknown>[],
  v2: null as null | (() => Promise<void>),
  legacyFails: false,
  legacyCalls: 0,
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  exists: async (id: string) => store.meeting?.id === id,
  findById: async (id: string) =>
    store.meeting?.id === id
      ? { ...store.meeting, summary: store.summary, transcript: store.transcript, actionItems: [] }
      : null,
  updateStatus: async (_id: string, status: string) => {
    if (store.meeting) store.meeting.status = status;
  },
  updateProcessing: async (
    _id: string,
    data: { stage?: string | null; progress?: number | null; error?: string | null; status?: string }
  ) => {
    store.processingWrites.push({ ...data });
    if (!store.meeting) return;
    if (data.stage !== undefined) store.meeting.processingStage = data.stage;
    if (data.progress !== undefined) store.meeting.processingProgress = data.progress;
    if (data.error !== undefined) store.meeting.processingError = data.error;
    if (data.status !== undefined) store.meeting.status = data.status;
  },
}));

vi.mock("../../src/repositories/transcript.repository", () => ({
  findByMeetingId: async () => store.transcript,
}));

vi.mock("../../src/repositories/segment.repository", () => ({
  findByMeetingId: async () => [
    { idx: 0, speaker: "Ana", text: "Ship it Friday.", startMs: 0, endMs: 2000 },
  ],
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
}));

vi.mock("../../src/services/w1-sum.service", () => ({
  resummarize: async () => {
    if (!store.v2) throw new Error("no v2 script");
    await store.v2();
  },
}));

vi.mock("../../src/services/summary.service", () => ({
  generateSummary: async (input: string) => {
    store.legacyCalls++;
    if (store.legacyFails) throw new Error("Gemini down");
    return {
      markdown: `# Legacy\n${input}`,
      structured: {
        executiveSummary: "Legacy summary.",
        keyDecisions: [],
        actionItems: [{ task: "Ship it", owner: "Ana", dueDate: null, priority: "MEDIUM" }],
        importantDates: [],
        followUps: [],
        risks: [],
        blockers: [],
        openQuestions: [],
        discussionTopics: [],
        keywords: [],
        sentiment: { overall: "neutral", rationale: "" },
      },
    };
  },
}));

vi.mock("../../src/services/embedding.service", () => ({
  indexMeeting: async () => undefined,
}));

const app = createApp();

/** A v2 run that only finishes when the test says so. */
const deferredV2 = () => {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  store.v2 = () => done;
  return { finish, fail };
};

beforeEach(() => {
  store.meeting = { id: "m1", status: "TRANSCRIBED", processingStage: null, processingError: null };
  store.transcript = { content: "Ship it Friday." };
  store.summary = null;
  store.actionItems = [];
  store.processingWrites = [];
  store.v2 = null;
  store.legacyFails = false;
  store.legacyCalls = 0;
});

describe("POST /api/meetings/:id/summarize (background)", () => {
  it("answers 202 before the summary finishes, then reaches DONE", async () => {
    const v2 = deferredV2();

    const res = await request(app).post("/api/meetings/m1/summarize");

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ meetingId: "m1", status: "PROCESSING", processingStage: "SUMMARIZING" });

    // The poll endpoint reports the running stage.
    const polled = await request(app).get("/api/meetings/m1");
    expect(polled.body.data.processingStage).toBe("SUMMARIZING");
    expect(polled.body.data.status).toBe("PROCESSING");
    expect(summaryJob("m1")).toBeDefined();

    v2.finish();
    await summaryJob("m1");

    const after = await request(app).get("/api/meetings/m1");
    expect(after.body.data).toMatchObject({
      processingStage: "DONE",
      processingProgress: 100,
      processingError: null,
      status: "COMPLETED",
    });
    expect(store.legacyCalls).toBe(0);
    expect(store.processingWrites.map((w) => w.stage).filter(Boolean)).toEqual(["SUMMARIZING", "DONE"]);
  });

  it("does not start a second run while one is in flight", async () => {
    const v2 = deferredV2();
    const calls = vi.fn();
    const inner = store.v2!;
    store.v2 = () => {
      calls();
      return inner();
    };

    await request(app).post("/api/meetings/m1/summarize").expect(202);
    await request(app).post("/api/meetings/m1/summarize").expect(202);

    v2.finish();
    await summaryJob("m1");
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy summary when v2 throws, and records it", async () => {
    const v2 = deferredV2();

    await request(app).post("/api/meetings/m1/summarize").expect(202);
    v2.fail(new Error("Gemini 503 after retries"));
    await summaryJob("m1");

    expect(store.legacyCalls).toBe(1);
    expect(store.summary?.data.pipeline).toBe("legacy");
    expect(store.actionItems).toHaveLength(1);
    expect(store.meeting).toMatchObject({
      processingStage: "DONE",
      processingError: PROCESSING_ERRORS.V2_FALLBACK,
      status: "COMPLETED",
    });
  });

  it("marks the meeting FAILED when both pipelines fail, with a safe message", async () => {
    const v2 = deferredV2();
    store.legacyFails = true;

    await request(app).post("/api/meetings/m1/summarize").expect(202);
    v2.fail(new Error("v2 down"));
    await summaryJob("m1");

    expect(store.meeting).toMatchObject({
      processingStage: "FAILED",
      processingError: PROCESSING_ERRORS.FAILED,
      status: "FAILED",
    });
    expect(String(store.meeting?.processingError)).not.toContain("Gemini down");
  });

  it("404s without a transcript and starts nothing", async () => {
    store.transcript = null;

    const res = await request(app).post("/api/meetings/m1/summarize");

    expect(res.status).toBe(404);
    expect(store.processingWrites).toEqual([]);
    expect(summaryJob("m1")).toBeUndefined();
  });
});
