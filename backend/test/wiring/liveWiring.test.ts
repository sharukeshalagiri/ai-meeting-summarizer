import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { tailWords } from "../../src/services/live.service";
import * as fakes from "../helpers/liveFakes";

/**
 * Live capture wiring: every chunk transcription gets the session's
 * layout, hints, roster and the previous chunk's tail words (D1 edge
 * de-dup), and /end starts the summary in the background.
 */

vi.mock("../../src/repositories/liveSession.repository", async () =>
  (await import("../helpers/liveFakes")).liveSessionRepo
);
vi.mock("../../src/repositories/liveChunk.repository", async () =>
  (await import("../helpers/liveFakes")).liveChunkRepo
);
vi.mock("../../src/repositories/segment.repository", async () =>
  (await import("../helpers/liveFakes")).segmentRepo
);
vi.mock("../../src/repositories/meeting.repository", async () =>
  (await import("../helpers/liveFakes")).meetingRepo
);
vi.mock("../../src/repositories/transcript.repository", () => ({
  upsert: async () => undefined,
}));
vi.mock("../../src/services/meeting.service", async () =>
  (await import("../helpers/liveFakes")).meetingService
);
vi.mock("../../src/services/speech.service", async () =>
  (await import("../helpers/liveFakes")).speechService
);
vi.mock("../../src/services/diarization.service", async () =>
  (await import("../helpers/liveFakes")).diarizationService
);
vi.mock("../../src/services/summary.service", async () =>
  (await import("../helpers/liveFakes")).summaryService
);

const app = createApp();

const start = async () => {
  const res = await request(app)
    .post("/api/live/sessions")
    .send({ title: "Standup", platform: "MEET", source: "EXTENSION", mode: "PROJECT", hints: ["Kubernetes"] });
  expect(res.status).toBe(201);
  return res.body.data as { sessionId: string; meetingId: string };
};

const sendChunk = (sessionId: string, seq: number, text: string) =>
  request(app)
    .post(`/api/live/sessions/${sessionId}/chunks`)
    .field("seq", String(seq))
    .field("startOffsetMs", String(seq * 20_000))
    .field("durationMs", "20000")
    .field("channelLayout", "stereo-mic-left")
    .attach("audio", Buffer.from(text), { filename: `chunk-${seq}.webm`, contentType: "audio/webm" });

type Options = {
  channelLayout: string;
  hints: string[];
  roster: string[];
  previousWords: { w: string; channel: string | null }[];
};

beforeEach(() => {
  fakes.reset();
  fakes.store.withWords = true;
});

describe("live chunk transcription options", () => {
  it("passes layout, hints, roster and the previous chunk's tail words", async () => {
    const { sessionId, meetingId } = await start();

    await request(app)
      .post(`/api/live/sessions/${sessionId}/roster`)
      .send({ participants: ["Priya Raman", "Marcus"] })
      .expect(200);

    await sendChunk(sessionId, 0, "one two three four five six seven eight").expect(200);
    await sendChunk(sessionId, 1, "eight nine ten").expect(200);

    const [first, second] = fakes.store.transcribeOptions as Options[];

    expect(first).toMatchObject({
      channelLayout: "stereo-mic-left",
      hints: ["Kubernetes"],
      roster: ["Priya Raman", "Marcus"],
      previousWords: [],
    });

    // seq 1 sees the last 6 words of seq 0, tagged with their channel.
    expect(second.previousWords.map((w) => w.w)).toEqual(["three", "four", "five", "six", "seven", "eight"]);
    expect(second.previousWords.every((w) => w.channel === "remote")).toBe(true);

    // channel and words survive diarization into the stored rows.
    const stored = fakes.store.segments.filter((s) => s.meetingId === meetingId);
    expect(stored[0]).toMatchObject({ idx: 0, channel: "remote" });
    expect(Array.isArray(stored[0].words)).toBe(true);
  });

  it("reads the previous chunk by seq, not the latest segments (out of order)", async () => {
    const { sessionId } = await start();

    await sendChunk(sessionId, 2, "late chunk words").expect(200);
    await sendChunk(sessionId, 1, "middle chunk").expect(200);

    const [forSeq2, forSeq1] = fakes.store.transcribeOptions as Options[];
    expect(forSeq2.previousWords).toEqual([]); // seq 1 had not arrived
    expect(forSeq1.previousWords).toEqual([]); // seq 0 never arrived; seq 2 is not "previous"
  });

  it("passes options on the legacy chunk path too", async () => {
    const { sessionId } = await start();

    const legacy = (text: string) =>
      request(app)
        .post(`/api/live/sessions/${sessionId}/chunks`)
        .field("durationMs", "5000")
        .attach("chunk", Buffer.from(text), { filename: "c.webm", contentType: "audio/webm" });

    await legacy("alpha beta").expect(200);
    await legacy("gamma").expect(200);

    const [, second] = fakes.store.transcribeOptions as Options[];
    expect(second).toMatchObject({ channelLayout: "mono", hints: ["Kubernetes"] });
    expect(second.previousWords.map((w) => w.w)).toEqual(["alpha", "beta"]);
  });
});

describe("POST /api/live/sessions/:id/end", () => {
  it("returns at once and starts the summary in the background", async () => {
    const { sessionId, meetingId } = await start();
    await sendChunk(sessionId, 0, "hello there").expect(200);

    const res = await request(app).post(`/api/live/sessions/${sessionId}/end`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ meetingId, alreadyEnded: false, summary: null, summarizing: true });
    expect(fakes.store.summariesStarted).toEqual([meetingId]);
  });
});

describe("tailWords", () => {
  it("keeps the last N words per channel, oldest first, skipping segments without words", () => {
    const words = (list: string[], at: number) =>
      list.map((w, i) => ({ w, startMs: at + i * 100, endMs: at + i * 100 + 90 }));

    const tail = tailWords(
      [
        { channel: "mic", words: words(["a", "b", "c"], 0) },
        { channel: "remote", words: words(["x", "y"], 50) },
        { channel: "mic", words: null },
        { channel: "mic", words: words(["d"], 1000) },
      ],
      2
    );

    expect(tail.map((w) => `${w.channel}:${w.w}`)).toEqual(["remote:x", "remote:y", "mic:c", "mic:d"]);
  });

  it("ignores malformed stored words", () => {
    expect(tailWords([{ channel: null, words: [{ w: 1 }, { w: "ok", startMs: 0, endMs: 1 }] }])).toEqual([
      { w: "ok", startMs: 0, endMs: 1, channel: null },
    ]);
  });
});
