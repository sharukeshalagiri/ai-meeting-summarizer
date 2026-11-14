import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { diarizeSegments } from "../../src/services/diarization.service";
import { cancelScheduledResummaries } from "../../src/services/live.service";
import * as fakes from "../helpers/liveFakes";

/**
 * The chunk-boundary split (engineer's brief, w2-spk item 3).
 *
 * Before: every live chunk was labelled by Gemini on its own, so one
 * person could be "Speaker 2" in chunk n and "Priya" in chunk n+1. Now
 * the remote channel is diarized by voice and each chunk's clusters are
 * matched to the meeting's SpeakerProfile centroids.
 *
 * Runs the real routes, live.service, diarization.service and speaker
 * matching. Fakes: repositories (in memory), Whisper (liveFakes), the
 * ai-service /diarize call (axios) and Gemini (textLabels).
 */

const state = vi.hoisted(() => ({
  profiles: [] as {
    id: string;
    meetingId: string;
    label: string;
    displayName: string | null;
    centroid: number[];
    source: string;
  }[],
  /** Centroid per segment text, as the fake ai-service "hears" it. */
  voices: new Map<string, number[]>(),
  voiceDown: false,
  diarizeRequests: [] as { segments: unknown[]; offset_ms: number; channel_layout: string }[],
  geminiScript: [] as string[][],
  geminiCalls: [] as { context: unknown[]; known: string[] }[],
  nextId: 0,
  /** The current chunk's segment texts, in order (fake ai-service). */
  lastTexts: [] as string[],
}));

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
vi.mock("../../src/repositories/transcript.repository", async () =>
  (await import("../helpers/liveFakes")).transcriptRepo
);
vi.mock("../../src/services/meeting.service", async () =>
  (await import("../helpers/liveFakes")).meetingService
);
vi.mock("../../src/services/speech.service", async () =>
  (await import("../helpers/liveFakes")).speechService
);
vi.mock("../../src/services/summary.service", async () =>
  (await import("../helpers/liveFakes")).summaryService
);

vi.mock("../../src/repositories/speakerProfile.repository", async () => {
  const { store } = await import("../helpers/liveFakes");
  const segmentsOf = (meetingId: string) =>
    store.segments.filter((s) => s.meetingId === meetingId) as (typeof store.segments[number] & {
      speakerId?: string;
    })[];

  return {
    findByMeetingId: async (meetingId: string) =>
      state.profiles.filter((p) => p.meetingId === meetingId).map((p) => ({ ...p })),
    create: async (data: { meetingId: string; label: string; centroid?: number[] }) => {
      if (state.profiles.some((p) => p.meetingId === data.meetingId && p.label === data.label)) {
        throw new Error("unique constraint (meetingId, label)");
      }
      const profile = {
        id: `profile-${++state.nextId}`,
        meetingId: data.meetingId,
        label: data.label,
        displayName: null,
        centroid: data.centroid ?? [],
        source: "DIARIZATION",
      };
      state.profiles.push(profile);
      return { ...profile };
    },
    updateCentroid: async (id: string, centroid: number[]) => {
      state.profiles.find((p) => p.id === id)!.centroid = centroid;
    },
    setDisplayName: async (id: string, displayName: string | null) => {
      state.profiles.find((p) => p.id === id)!.displayName = displayName;
    },
    assignSegments: async (meetingId: string, links: { idx: number; speakerId: string }[]) => {
      for (const link of links) {
        const row = segmentsOf(meetingId).find((s) => s.idx === link.idx);
        if (row) row.speakerId = link.speakerId;
      }
      return links.length;
    },
    renameSegmentsOf: async (meetingId: string, speakerId: string, speaker: string) => {
      const rows = segmentsOf(meetingId).filter((s) => s.speakerId === speakerId);
      rows.forEach((row) => (row.speaker = speaker));
      return rows.length;
    },
  };
});

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  const post = async (url: string, body: Record<string, unknown>) => {
    if (!url.endsWith("/diarize")) throw new Error(`unexpected ${url}`);
    state.diarizeRequests.push(body as never);
    if (state.voiceDown) {
      throw Object.assign(new Error("Service Unavailable"), {
        isAxiosError: true,
        response: { status: 503 },
      });
    }
    // The fake ai-service clusters segments by their scripted voice.
    const segments = body.segments as { startMs: number }[];
    const texts = state.lastTexts;
    const byVoice = new Map<string, number[]>();
    segments.forEach((_, i) => {
      const key = JSON.stringify(state.voices.get(texts[i]) ?? [1, 0, 0]);
      byVoice.set(key, [...(byVoice.get(key) ?? []), i]);
    });
    return {
      data: {
        clusters: [...byVoice.entries()].map(([key, members]) => ({
          members,
          centroid: JSON.parse(key),
          speechMs: members.length * 1000,
        })),
      },
    };
  };
  return {
    ...actual,
    default: { ...actual.default, post, isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError },
  };
});

vi.mock("../../src/services/speakers/textLabels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/speakers/textLabels")>();
  return {
    ...actual,
    labelWithGemini: async (
      segments: { text: string }[],
      context: unknown[] = [],
      known: string[] = []
    ) => {
      state.geminiCalls.push({ context, known });
      const script = state.geminiScript.shift() ?? [];
      return segments.map((_, i) => script[i] ?? script[script.length - 1] ?? "Speaker 1");
    },
  };
});

// Remember each chunk's segment texts, in order, for the fake ai-service.
const originalTranscribe = fakes.speechService.transcribeAudioDetailed;
fakes.speechService.transcribeAudioDetailed = async (...args) => {
  const result = await originalTranscribe(...args);
  state.lastTexts = result.segments.map((s) => s.text);
  return result;
};

const app = createApp();

const startSession = async () => {
  const res = await request(app)
    .post("/api/live/sessions")
    .send({ title: "Sync", platform: "MEET", source: "EXTENSION", mode: "PROJECT" });
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
    .attach("audio", Buffer.from(text), {
      filename: `chunk-${seq}.webm`,
      contentType: "audio/webm",
    });

const segmentsOf = (meetingId: string) =>
  (fakes.store.segments as (typeof fakes.store.segments[number] & { speakerId?: string })[])
    .filter((s) => s.meetingId === meetingId)
    .sort((a, b) => a.idx - b.idx);

beforeEach(() => {
  fakes.reset();
  fakes.store.withWords = true; // segments carry channel "remote"
  state.profiles = [];
  state.voices = new Map();
  state.voiceDown = false;
  state.diarizeRequests = [];
  state.geminiScript = [];
  state.geminiCalls = [];
});

afterEach(() => cancelScheduledResummaries());

describe("chunk-boundary speaker split", () => {
  it("reproduces the bug: per-chunk text labels split one speaker", async () => {
    // What live.service did before: each chunk labelled on its own.
    state.geminiScript = [["Speaker 2"], ["Priya"]];

    const chunk0 = await diarizeSegments([
      { text: "the rollout is on track", startMs: 18_000, endMs: 19_500 },
    ]);
    const chunk1 = await diarizeSegments([
      { text: "and the migration too", startMs: 20_000, endMs: 21_000 },
    ]);

    expect(chunk0[0].speaker).toBe("Speaker 2");
    expect(chunk1[0].speaker).toBe("Priya");
  });

  it("fix: one voice across a chunk boundary keeps one profile and label", async () => {
    const { sessionId, meetingId } = await startSession();
    state.voices.set("the rollout is on track", [0.9, 0.1, 0]);
    state.voices.set("and the migration too", [0.85, 0.15, 0.05]);
    // Gemini would split them; voice matching never asks it.
    state.geminiScript = [["Speaker 2"], ["Priya"]];

    expect((await sendChunk(sessionId, 0, "the rollout is on track")).status).toBe(200);
    expect((await sendChunk(sessionId, 1, "and the migration too")).status).toBe(200);

    const rows = segmentsOf(meetingId);
    expect(rows.map((r) => r.idx)).toEqual([0, 1000]);
    expect(rows[0].speakerId).toBeDefined();
    expect(rows[1].speakerId).toBe(rows[0].speakerId);
    expect(rows.map((r) => r.speaker)).toEqual(["Speaker 1", "Speaker 1"]);
    expect(state.profiles).toHaveLength(1);
    expect(state.geminiCalls).toHaveLength(0);

    // The request told the ai-service where the chunk sits.
    expect(state.diarizeRequests[1]).toMatchObject({
      offset_ms: 20_000,
      channel_layout: "stereo-mic-left",
    });
  });

  it("keeps two voices apart even when their order flips between chunks", async () => {
    const { sessionId, meetingId } = await startSession();
    state.voices.set("status from platform", [1, 0, 0]);
    state.voices.set("status from design", [0, 1, 0]);
    state.voices.set("design again", [0.05, 0.95, 0]);
    state.voices.set("platform again", [0.95, 0.05, 0]);

    await sendChunk(sessionId, 0, "status from platform | status from design");
    await sendChunk(sessionId, 1, "design again | platform again");

    const bySpeaker = Object.fromEntries(
      segmentsOf(meetingId).map((r) => [r.text, r.speaker])
    );
    expect(bySpeaker).toEqual({
      "status from platform": "Speaker 1",
      "status from design": "Speaker 2",
      "design again": "Speaker 2",
      "platform again": "Speaker 1",
    });
    expect(state.profiles).toHaveLength(2);
  });

  it("without voice diarization, the text fallback sees the previous chunk and known labels", async () => {
    const { sessionId, meetingId } = await startSession();
    state.voiceDown = true;
    state.geminiScript = [["Speaker 2"], ["Speaker 2"]];

    await sendChunk(sessionId, 0, "the rollout is on track");
    await sendChunk(sessionId, 1, "and the migration too");

    expect(state.geminiCalls[1]).toEqual({
      context: [{ speaker: "Speaker 2", text: "the rollout is on track" }],
      known: ["Speaker 2"],
    });
    const rows = segmentsOf(meetingId);
    expect(rows[1].speakerId).toBe(rows[0].speakerId);
    expect(state.profiles).toHaveLength(1);
  });

  it("names a speaker automatically only with two signals", async () => {
    const { sessionId, meetingId } = await startSession();
    await request(app)
      .post(`/api/live/sessions/${sessionId}/roster`)
      .send({ participants: ["Priya Sharma"] });
    state.voices.set("Hi all, I'm Priya.", [1, 0, 0]);
    state.voices.set("I'm Frank about this.", [0, 1, 0]);

    await sendChunk(sessionId, 0, "Hi all, I'm Priya. | I'm Frank about this.");

    const names = segmentsOf(meetingId).map((r) => r.speaker);
    expect(names).toEqual(["Priya Sharma", "Speaker 2"]);
  });
});
