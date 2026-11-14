import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import {
  cancelScheduledResummaries,
  reapStaleSessions,
} from "../src/services/live.service";
import * as fakes from "./helpers/liveFakes";

/**
 * Capture contract (docs/CAPTURE_CONTRACT.md) end to end through the
 * real routes, controller, and service, with repositories and upstream
 * services replaced by in-memory fakes.
 */

vi.mock("../src/repositories/liveSession.repository", async () =>
  (await import("./helpers/liveFakes")).liveSessionRepo
);
vi.mock("../src/repositories/liveChunk.repository", async () =>
  (await import("./helpers/liveFakes")).liveChunkRepo
);
vi.mock("../src/repositories/segment.repository", async () =>
  (await import("./helpers/liveFakes")).segmentRepo
);
vi.mock("../src/repositories/meeting.repository", async () =>
  (await import("./helpers/liveFakes")).meetingRepo
);
vi.mock("../src/repositories/transcript.repository", async () =>
  (await import("./helpers/liveFakes")).transcriptRepo
);
vi.mock("../src/services/meeting.service", async () =>
  (await import("./helpers/liveFakes")).meetingService
);
vi.mock("../src/services/speech.service", async () =>
  (await import("./helpers/liveFakes")).speechService
);
vi.mock("../src/services/diarization.service", async () =>
  (await import("./helpers/liveFakes")).diarizationService
);
vi.mock("../src/services/summary.service", async () =>
  (await import("./helpers/liveFakes")).summaryService
);

// vi.mock calls are hoisted above the imports, so createApp sees fakes.
const app = createApp();

const startSession = async (body: Record<string, unknown> = {}) => {
  const res = await request(app)
    .post("/api/live/sessions")
    .send({
      title: "Standup",
      platform: "MEET",
      source: "EXTENSION",
      mode: "PROJECT",
      hints: ["Kubernetes"],
      ...body,
    });

  expect(res.status).toBe(201);
  return res.body.data as { sessionId: string; meetingId: string };
};

const sendChunk = (
  sessionId: string,
  seq: number,
  text: string,
  extra: Record<string, string> = {}
) =>
  request(app)
    .post(`/api/live/sessions/${sessionId}/chunks`)
    .field("seq", String(seq))
    .field("startOffsetMs", String(seq * 20_000))
    .field("durationMs", "20000")
    .field("channelLayout", extra.channelLayout ?? "stereo-mic-left")
    .attach("audio", Buffer.from(text), {
      filename: `chunk-${seq}.webm`,
      contentType: "audio/webm",
    });

beforeEach(() => fakes.reset());

describe("POST /api/live/sessions", () => {
  it("returns sessionId and meetingId and stores contract fields", async () => {
    const { sessionId, meetingId } = await startSession();

    const session = fakes.store.sessions.get(sessionId)!;
    expect(session.meetingId).toBe(meetingId);
    expect(session.platform).toBe("GOOGLE_MEET");
    expect(session.source).toBe("EXTENSION");
    expect(session.hints).toEqual(["Kubernetes"]);
    expect(fakes.store.meetings.get(meetingId)!.mode).toBe("PROJECT");
  });

  it("rejects an unknown source or mode", async () => {
    const bad = await request(app)
      .post("/api/live/sessions")
      .send({ title: "x", source: "FAX" });
    expect(bad.status).toBe(400);

    const badMode = await request(app)
      .post("/api/live/sessions")
      .send({ title: "x", mode: "PARTY" });
    expect(badMode.status).toBe(400);
  });

  it("still accepts the legacy web-page body", async () => {
    const res = await request(app)
      .post("/api/live/sessions")
      .send({ title: "Legacy", platform: "GOOGLE_MEET" });

    expect(res.status).toBe(201);
    expect(res.body.data.meeting.id).toBeDefined();
    expect(res.body.data.session.id).toBeDefined();
  });
});

describe("POST /api/live/sessions/:id/chunks (contract)", () => {
  it("places segments by seq with sparse idx and client offsets", async () => {
    const { sessionId, meetingId } = await startSession();

    const res = await sendChunk(sessionId, 0, "hello | world");

    expect(res.status).toBe(200);
    expect(res.body.data.duplicate).toBe(false);
    expect(res.body.data.segments.map((s: { idx: number }) => s.idx)).toEqual([
      0, 1,
    ]);

    const stored = await fakes.segmentRepo.findByMeetingId(meetingId);
    expect(stored.map((s) => [s.idx, s.startMs])).toEqual([
      [0, 0],
      [1, 1000],
    ]);
  });

  it("orders out-of-order chunks by seq", async () => {
    const { sessionId, meetingId } = await startSession();

    expect((await sendChunk(sessionId, 2, "third")).status).toBe(200);
    expect((await sendChunk(sessionId, 0, "first")).status).toBe(200);
    expect((await sendChunk(sessionId, 1, "second | more")).status).toBe(200);

    const stored = await fakes.segmentRepo.findByMeetingId(meetingId);

    expect(stored.map((s) => s.text)).toEqual([
      "first",
      "second",
      "more",
      "third",
    ]);
    expect(stored.map((s) => s.idx)).toEqual([0, 1000, 1001, 2000]);
    expect(stored.map((s) => s.startMs)).toEqual([0, 20_000, 21_000, 40_000]);

    // elapsedMs tracks the furthest chunk end, not arrival order.
    expect(fakes.store.sessions.get(sessionId)!.elapsedMs).toBe(60_000);
  });

  it("is idempotent on (sessionId, seq): replays with duplicate:true", async () => {
    const { sessionId, meetingId } = await startSession();

    const first = await sendChunk(sessionId, 0, "only once");
    const second = await sendChunk(sessionId, 0, "only once");

    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.segments).toEqual(first.body.data.segments);
    expect(fakes.store.transcribeCalls).toBe(1);
    expect(await fakes.segmentRepo.findByMeetingId(meetingId)).toHaveLength(1);
    expect(fakes.store.sessions.get(sessionId)!.chunkCount).toBe(1);
  });

  it("returns 409 while the same seq is still processing", async () => {
    const { sessionId } = await startSession();

    let release!: () => void;
    fakes.store.gate = new Promise<void>((resolve) => (release = resolve));

    const firstPending = sendChunk(sessionId, 5, "slow").then((r) => r);
    // Let the first request reach the gate before sending the repeat.
    await vi.waitFor(() => expect(fakes.store.transcribeCalls).toBe(1));

    const repeat = await sendChunk(sessionId, 5, "slow");
    expect(repeat.status).toBe(409);

    release();
    expect((await firstPending).status).toBe(200);
  });

  it("retries a chunk whose first attempt failed", async () => {
    const { sessionId, meetingId } = await startSession();

    fakes.store.failNext = true;
    const failed = await sendChunk(sessionId, 3, "retry me");
    expect(failed.status).toBe(500);
    expect(fakes.store.chunks[0].status).toBe("FAILED");

    const retried = await sendChunk(sessionId, 3, "retry me");
    expect(retried.status).toBe(200);
    expect(retried.body.data.duplicate).toBe(false);
    expect(await fakes.segmentRepo.findByMeetingId(meetingId)).toHaveLength(1);
  });

  it("validates seq, offsets and channelLayout", async () => {
    const { sessionId } = await startSession();

    const noOffset = await request(app)
      .post(`/api/live/sessions/${sessionId}/chunks`)
      .field("seq", "0")
      .attach("audio", Buffer.from("x"), {
        filename: "c.webm",
        contentType: "audio/webm",
      });
    expect(noOffset.status).toBe(400);

    const badLayout = await sendChunk(sessionId, 0, "x", {
      channelLayout: "surround",
    });
    expect(badLayout.status).toBe(400);

    const negativeSeq = await sendChunk(sessionId, -1, "x");
    expect(negativeSeq.status).toBe(400);
  });

  it("returns 410 once the session ended over 24 h ago, but still replays duplicates", async () => {
    const { sessionId } = await startSession();

    await sendChunk(sessionId, 0, "before end");
    await fakes.liveSessionRepo.end(sessionId);
    fakes.store.sessions.get(sessionId)!.endedAt = new Date(
      Date.now() - 25 * 60 * 60 * 1000
    );

    expect((await sendChunk(sessionId, 1, "too late")).status).toBe(410);

    const replay = await sendChunk(sessionId, 0, "before end");
    expect(replay.status).toBe(200);
    expect(replay.body.data.duplicate).toBe(true);
  });
});

describe("late chunks (after the session ended)", () => {
  const TWO_MIN = 2 * 60 * 1000;

  const end = (sessionId: string) =>
    request(app).post(`/api/live/sessions/${sessionId}/end`).send({});

  beforeEach(() => {
    cancelScheduledResummaries();
    // Only the debounce timer is faked; supertest and Express keep
    // their real timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cancelScheduledResummaries();
    vi.useRealTimers();
  });

  it("accepts a chunk after /end with the right idx, without reopening", async () => {
    const { sessionId } = await startSession();

    await sendChunk(sessionId, 0, "before");
    expect((await end(sessionId)).status).toBe(200);

    const late = await sendChunk(sessionId, 1, "late one | late two");

    expect(late.status).toBe(200);
    expect(late.body.data.duplicate).toBe(false);
    expect(late.body.data.rollingSummaryGenerated).toBe(false);
    expect(late.body.data.segments.map((s: { idx: number }) => s.idx)).toEqual([
      1000, 1001,
    ]);
    expect(fakes.store.sessions.get(sessionId)!.status).toBe("ENDED");
  });

  it("accepts a chunk after the idle reaper ended the session", async () => {
    const { sessionId } = await startSession();

    await sendChunk(sessionId, 0, "before");
    expect(await reapStaleSessions()).toBe(1);
    expect(fakes.store.sessions.get(sessionId)!.status).toBe("ENDED");

    const late = await sendChunk(sessionId, 2, "after reap");
    expect(late.status).toBe(200);
    expect(late.body.data.segments[0].idx).toBe(2000);
  });

  it("re-summarizes once, 2 minutes after the last of several late chunks", async () => {
    const { sessionId, meetingId } = await startSession();

    await sendChunk(sessionId, 0, "before");
    await end(sessionId);
    expect(fakes.store.summariesStarted).toEqual([meetingId]);

    expect((await sendChunk(sessionId, 1, "late a")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(TWO_MIN - 30_000);
    expect((await sendChunk(sessionId, 2, "late b")).status).toBe(200);

    // 2 min after the first, but only 1.5 min after the second.
    await vi.advanceTimersByTimeAsync(TWO_MIN - 30_000);
    expect(fakes.store.summariesStarted).toEqual([meetingId]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fakes.store.summariesStarted).toEqual([meetingId, meetingId]);
    expect(fakes.store.transcripts.get(meetingId)).toBe(
      "before late a late b"
    );
    expect(fakes.store.meetings.get(meetingId)!.durationSec).toBe(60);

    await vi.advanceTimersByTimeAsync(10 * TWO_MIN);
    expect(fakes.store.summariesStarted).toHaveLength(2);
  });

  it("does not re-summarize for a duplicate or a silent late chunk", async () => {
    const { sessionId, meetingId } = await startSession();

    await sendChunk(sessionId, 0, "before");
    await end(sessionId);

    const duplicate = await sendChunk(sessionId, 0, "before");
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.duplicate).toBe(true);

    const silent = await sendChunk(sessionId, 1, " ");
    expect(silent.status).toBe(200);
    expect(silent.body.data.segments).toEqual([]);

    await vi.advanceTimersByTimeAsync(10 * TWO_MIN);
    expect(fakes.store.summariesStarted).toEqual([meetingId]);
  });

  it("waits another 2 minutes while a summary is still running", async () => {
    const { sessionId, meetingId } = await startSession();

    await sendChunk(sessionId, 0, "before");
    await end(sessionId);
    fakes.store.runningSummaries.add(meetingId);

    await sendChunk(sessionId, 1, "late");
    await vi.advanceTimersByTimeAsync(TWO_MIN);
    expect(fakes.store.summariesStarted).toEqual([meetingId]);

    fakes.store.runningSummaries.delete(meetingId);
    await vi.advanceTimersByTimeAsync(TWO_MIN);
    expect(fakes.store.summariesStarted).toEqual([meetingId, meetingId]);
  });

  it("marks a session that ends with no speech NO_SPEECH, not FAILED", async () => {
    const { sessionId, meetingId } = await startSession();

    await sendChunk(sessionId, 0, " ");
    expect((await end(sessionId)).status).toBe(200);

    const meeting = fakes.store.meetings.get(meetingId)!;
    expect(meeting.processingStage).toBe("NO_SPEECH");
    expect(meeting.status).toBe("COMPLETED");
    expect(fakes.store.summariesStarted).toEqual([]);
  });

  it("moves a NO_SPEECH meeting to TRANSCRIBED and re-summarizes on late speech", async () => {
    const { sessionId, meetingId } = await startSession();

    await end(sessionId);
    expect(fakes.store.meetings.get(meetingId)!.processingStage).toBe(
      "NO_SPEECH"
    );

    expect((await sendChunk(sessionId, 0, "finally audio")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(TWO_MIN);

    const meeting = fakes.store.meetings.get(meetingId)!;
    expect(meeting.status).toBe("TRANSCRIBED");
    expect(meeting.processingStage).toBeNull();
    expect(fakes.store.transcripts.get(meetingId)).toBe("finally audio");
    expect(fakes.store.summariesStarted).toEqual([meetingId]);
  });

  it("schedules a re-summary for a chunk claimed before /end that finishes after it", async () => {
    vi.useRealTimers();
    const { sessionId, meetingId } = await startSession();

    let release!: () => void;
    fakes.store.gate = new Promise<void>((resolve) => (release = resolve));

    const pending = sendChunk(sessionId, 0, "in flight").then((r) => r);
    await vi.waitFor(() => expect(fakes.store.transcribeCalls).toBe(1));

    // /end sees no segments yet.
    expect((await end(sessionId)).status).toBe(200);
    expect(fakes.store.meetings.get(meetingId)!.processingStage).toBe(
      "NO_SPEECH"
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    release();
    expect((await pending).status).toBe(200);
    expect(fakes.store.summariesStarted).toEqual([]);

    await vi.advanceTimersByTimeAsync(TWO_MIN);
    expect(fakes.store.summariesStarted).toEqual([meetingId]);
    expect(fakes.store.meetings.get(meetingId)!.status).toBe("TRANSCRIBED");
  });
});

describe("legacy chunk upload", () => {
  it("still works with the 'chunk' field and no seq", async () => {
    const { sessionId, meetingId } = await startSession({ source: undefined });

    const res = await request(app)
      .post(`/api/live/sessions/${sessionId}/chunks`)
      .field("durationMs", "20000")
      .attach("chunk", Buffer.from("legacy line"), {
        filename: "chunk-1.webm",
        contentType: "audio/webm",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.chunkCount).toBe(1);
    expect(
      (await fakes.segmentRepo.findByMeetingId(meetingId)).map((s) => s.text)
    ).toEqual(["legacy line"]);
  });
});

describe("POST /api/live/sessions/:id/roster", () => {
  it("stores trimmed, de-duplicated names on the session", async () => {
    const { sessionId } = await startSession();

    const res = await request(app)
      .post(`/api/live/sessions/${sessionId}/roster`)
      .send({ participants: [" Priya ", "Marcus", { name: "Priya" }, ""] });

    expect(res.status).toBe(200);
    expect(res.body.data.roster).toEqual(["Priya", "Marcus"]);
    expect(fakes.store.sessions.get(sessionId)!.roster).toEqual([
      "Priya",
      "Marcus",
    ]);
  });

  it("rejects a non-array", async () => {
    const { sessionId } = await startSession();

    const res = await request(app)
      .post(`/api/live/sessions/${sessionId}/roster`)
      .send({ participants: "Priya" });

    expect(res.status).toBe(400);
  });
});
