import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { JobContext } from "../../src/jobs/queue";
import type { PipelineJob } from "../../src/jobs/definitions";

/**
 * The upload pipeline's DIARIZING step passes the meeting context, so
 * DIARIZATION_PROVIDER applies to uploads like live chunks (voice: the
 * ai-service /diarize and SpeakerProfiles; text: Gemini labels), and
 * mic lines take the owner's Settings display name, falling back to
 * ME_DISPLAY_NAME. The ai-service (axios) and Gemini (labelWithGemini)
 * are mocked; repositories are in memory.
 */

const AUDIO = "uploads/meetings/rec.webm";

type Fn = Mock<(...args: unknown[]) => unknown>;

const db = vi.hoisted(() => ({
  segments: [] as Record<string, unknown>[],
  profiles: [] as {
    id: string;
    meetingId: string;
    label: string;
    displayName: string | null;
    centroid: number[];
    source: string;
  }[],
  links: [] as { idx: number; speakerId: string }[],
  profilesDown: false,
  n: 0,
  post: null as unknown as Fn,
  labelWithGemini: null as unknown as Fn,
  enqueue: null as unknown as Fn,
}));

vi.mock("axios", async () => {
  const { vi } = await import("vitest");
  db.post ??= vi.fn();
  const axios = { post: (...args: unknown[]) => db.post(...args), isAxiosError: () => false };
  return { default: axios, ...axios };
});

vi.mock("../../src/services/speakers/textLabels", async (importOriginal) => {
  const { vi } = await import("vitest");
  db.labelWithGemini ??= vi.fn();
  return {
    ...(await importOriginal<object>()),
    labelWithGemini: (...args: unknown[]) => db.labelWithGemini(...args),
  };
});

vi.mock("../../src/lib/storage", () => ({
  storageKeys: { asr: (id: string) => `asr/${id}.json` },
  getStorage: () => ({
    get: async () =>
      Buffer.from(
        JSON.stringify({
          text: "Can someone own the budget? I'll send the draft. And I'll review it.",
          durationMs: 12_000,
          segments: [
            { text: "Can someone own the budget?", startMs: 0, endMs: 3000, channel: "mic" },
            { text: "I'll send the draft.", startMs: 3500, endMs: 7000, channel: "remote" },
            { text: "And I'll review it.", startMs: 7500, endMs: 11_000, channel: "remote" },
          ],
        })
      ),
    put: async () => undefined,
  }),
}));

vi.mock("../../src/jobs/index", async () => {
  const { vi } = await import("vitest");
  db.enqueue ??= vi.fn(async () => "job-1");
  return { enqueue: (...args: unknown[]) => db.enqueue(...args) };
});

vi.mock("../../src/jobs/progress", () => ({
  setProgress: async () => undefined,
  trySetProgress: async () => undefined,
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  findById: async (id: string) => ({ id, audioPath: AUDIO, status: "PROCESSING" }),
  updateDuration: async () => undefined,
}));

vi.mock("../../src/repositories/transcript.repository", () => ({
  upsert: async () => ({}),
}));

vi.mock("../../src/repositories/segment.repository", () => ({
  replaceForMeeting: async (_id: string, segments: Record<string, unknown>[]) => {
    db.segments = segments.map((segment, idx) => ({ ...segment, idx }));
  },
  findByMeetingId: async () => db.segments,
}));

vi.mock("../../src/repositories/speakerProfile.repository", () => ({
  findByMeetingId: async (id: string) => {
    if (db.profilesDown) throw new Error("database unavailable");
    return db.profiles.filter((p) => p.meetingId === id);
  },
  create: async (data: { meetingId: string; label: string; centroid?: number[] }) => {
    const profile = {
      id: `p${++db.n}`,
      meetingId: data.meetingId,
      label: data.label,
      displayName: null,
      centroid: data.centroid ?? [],
      source: "DIARIZATION",
    };
    db.profiles.push(profile);
    return profile;
  },
  updateCentroid: async () => undefined,
  setDisplayName: async () => undefined,
  renameSegmentsOf: async () => 0,
  assignSegments: async (_meetingId: string, links: { idx: number; speakerId: string }[]) => {
    db.links.push(...links);
  },
}));

/** A fresh pipeline module with DIARIZATION_PROVIDER set (it is read once). */
const loadPipeline = async (provider: "voice" | "text") => {
  vi.resetModules();
  process.env.DIARIZATION_PROVIDER = provider;
  const pipeline = await import("../../src/jobs/pipeline");
  const context = await import("../../src/services/account/context");
  // The owner's Settings display name; none without a meeting.
  vi.mocked(context.meLabelForMeeting).mockImplementation(async (id) =>
    id ? "Asha" : process.env.ME_DISPLAY_NAME || "You"
  );
  return pipeline;
};

const job: JobContext<PipelineJob> = {
  id: "j1",
  name: "diarize",
  data: { meetingId: "m1", origin: "upload" } as PipelineJob,
  retryCount: 0,
  retryLimit: 2,
};

const speakers = () => db.segments.map((s) => s.speaker);

const previousProvider = process.env.DIARIZATION_PROVIDER;
afterAll(() => {
  if (previousProvider === undefined) delete process.env.DIARIZATION_PROVIDER;
  else process.env.DIARIZATION_PROVIDER = previousProvider;
});

beforeEach(() => {
  db.segments = [];
  db.profiles = [];
  db.links = [];
  db.profilesDown = false;
  db.n = 0;
  db.post?.mockReset();
  db.labelWithGemini?.mockReset();
});

describe("upload diarization follows DIARIZATION_PROVIDER", () => {
  it("voice: calls the ai-service /diarize with the recording and stores profiles", async () => {
    const { diarize } = await loadPipeline("voice");
    db.post.mockResolvedValue({
      data: {
        clusters: [
          { members: [0], centroid: [1, 0, 0] },
          { members: [1], centroid: [0, 1, 0] },
        ],
      },
    });

    await diarize(job);

    expect(db.post).toHaveBeenCalledTimes(1);
    const [url, body] = db.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toMatch(/\/diarize$/);
    expect(body).toMatchObject({
      file_path: path.resolve(AUDIO),
      offset_ms: 0,
      channel_layout: "mono",
    });
    expect(db.labelWithGemini).not.toHaveBeenCalled();

    // Mic line: the owner's display name; two voices, two profiles.
    const [me, first, second] = speakers();
    expect(me).toBe("Asha");
    expect(first).not.toBe(second);
    expect(db.profiles.map((p) => p.label).sort()).toEqual(["Speaker 1", "Speaker 2", "mic"]);

    // Every segment is linked to its profile by idx (0..n-1).
    expect(db.links.map((l) => l.idx).sort()).toEqual([0, 1, 2]);
    const remote = db.profiles.find((p) => p.id === db.links.find((l) => l.idx === 1)?.speakerId);
    expect(remote?.label).toBe(first);
  });

  it("text: labels with Gemini and never calls the ai-service", async () => {
    const { diarize } = await loadPipeline("text");
    db.labelWithGemini.mockResolvedValue(["Speaker 1", "Speaker 2"]);

    await diarize(job);

    expect(db.labelWithGemini).toHaveBeenCalledTimes(1);
    expect(db.post).not.toHaveBeenCalled();
    expect(speakers()).toEqual(["Asha", "Speaker 1", "Speaker 2"]);
    expect(db.links).toHaveLength(3);
  });

  it("voice unavailable: falls back to text labels; mic is still the display name", async () => {
    const { diarize } = await loadPipeline("voice");
    db.post.mockRejectedValue(new Error("ECONNREFUSED"));
    db.labelWithGemini.mockResolvedValue(["Speaker 1", "Speaker 1"]);

    await diarize(job);

    expect(db.post).toHaveBeenCalledTimes(1);
    expect(speakers()).toEqual(["Asha", "Speaker 1", "Speaker 1"]);
  });
});

describe("mic lines use the owner's display name on every path", () => {
  it("profile attribution fails: the text fallback still uses the display name", async () => {
    const { diarize } = await loadPipeline("voice");
    db.profilesDown = true;
    db.labelWithGemini.mockResolvedValue(["Speaker 1", "Speaker 2"]);

    await diarize(job);

    expect(speakers()).toEqual(["Asha", "Speaker 1", "Speaker 2"]);
    expect(db.links).toHaveLength(0);
  });

  it("no meeting context (evaluation): ME_DISPLAY_NAME", async () => {
    await loadPipeline("text");
    const { diarizeSegments } = await import("../../src/services/diarization.service");
    db.labelWithGemini.mockResolvedValue(["Speaker 1"]);

    const out = await diarizeSegments([
      { text: "Hello.", startMs: 0, endMs: 1000, channel: "mic" },
      { text: "Hi.", startMs: 1000, endMs: 2000, channel: "remote" },
    ] as never);

    expect(out.map((s) => s.speaker)).toEqual([process.env.ME_DISPLAY_NAME || "You", "Speaker 1"]);
  });
});
