import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import {
  withOwnerNames,
  withSpeakerNames,
} from "../../src/services/speakers/speakers.service";

/**
 * GET /meetings/:id/speakers, PATCH rename, POST accept, and the
 * read-time projection, with in-memory repositories.
 */

const db = vi.hoisted(() => ({
  meetings: new Set<string>(),
  profiles: [] as {
    id: string;
    meetingId: string;
    label: string;
    displayName: string | null;
    centroid: number[];
    source: string;
  }[],
  segments: [] as {
    meetingId: string;
    idx: number;
    speaker: string;
    speakerId: string | null;
    channel: string | null;
    text: string;
  }[],
  corrections: [] as {
    meetingId: string;
    kind: string;
    targetId: string | null;
    before: unknown;
    after: unknown;
  }[],
  rosters: new Map<string, string[]>(),
  n: 0,
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  exists: async (id: string) => db.meetings.has(id),
}));
vi.mock("../../src/repositories/liveSession.repository", () => ({
  findByMeetingId: async (id: string) =>
    db.rosters.has(id) ? { roster: db.rosters.get(id) } : null,
}));
vi.mock("../../src/repositories/segment.repository", () => ({
  findByMeetingId: async (id: string) =>
    db.segments.filter((s) => s.meetingId === id).sort((a, b) => a.idx - b.idx),
}));
vi.mock("../../src/repositories/correction.repository", () => ({
  record: async (input: (typeof db.corrections)[number]) => {
    db.corrections.push({ ...input, targetId: input.targetId ?? null });
    return input;
  },
  findByMeetingId: async (id: string) => db.corrections.filter((c) => c.meetingId === id),
}));
vi.mock("../../src/repositories/speakerProfile.repository", () => {
  const rows = (meetingId: string) => db.segments.filter((s) => s.meetingId === meetingId);
  return {
    findByMeetingId: async (id: string) => db.profiles.filter((p) => p.meetingId === id),
    findById: async (id: string) => db.profiles.find((p) => p.id === id) ?? null,
    findByLabel: async (meetingId: string, label: string) =>
      db.profiles.find((p) => p.meetingId === meetingId && p.label === label) ?? null,
    create: async (data: { meetingId: string; label: string; source?: string }) => {
      const p = {
        id: `p${++db.n}`,
        meetingId: data.meetingId,
        label: data.label,
        displayName: null,
        centroid: [],
        source: data.source ?? "DIARIZATION",
      };
      db.profiles.push(p);
      return p;
    },
    setDisplayName: async (id: string, name: string, source?: string) => {
      const p = db.profiles.find((x) => x.id === id)!;
      p.displayName = name;
      if (source) p.source = source;
      return p;
    },
    renameSegmentsOf: async (meetingId: string, speakerId: string, speaker: string) => {
      const list = rows(meetingId).filter((s) => s.speakerId === speakerId);
      list.forEach((s) => (s.speaker = speaker));
      return list.length;
    },
    adoptSegmentsByLabel: async (
      meetingId: string,
      label: string,
      speakerId: string,
      speaker: string
    ) => {
      const list = rows(meetingId).filter((s) => !s.speakerId && s.speaker === label);
      list.forEach((s) => Object.assign(s, { speakerId, speaker }));
      return list.length;
    },
    segmentIdxOf: async (meetingId: string, speakerId: string) =>
      rows(meetingId)
        .filter((s) => s.speakerId === speakerId)
        .map((s) => s.idx),
  };
});

const app = createApp();

const addSegment = (
  idx: number,
  speaker: string,
  text: string,
  speakerId: string | null = null,
  channel: string | null = "remote"
) => db.segments.push({ meetingId: "m1", idx, speaker, text, speakerId, channel });

beforeEach(() => {
  db.meetings = new Set(["m1"]);
  db.profiles = [];
  db.segments = [];
  db.corrections = [];
  db.rosters = new Map();
  db.n = 0;
});

describe("GET /api/meetings/:id/speakers", () => {
  it("lists profiles and legacy labels, with a suggestion when one signal exists", async () => {
    db.profiles.push(
      { id: "mic1", meetingId: "m1", label: "mic", displayName: null, centroid: [], source: "DIARIZATION" },
      { id: "s2", meetingId: "m1", label: "Speaker 2", displayName: null, centroid: [1], source: "DIARIZATION" }
    );
    addSegment(0, "You", "Morning all", "mic1", "mic");
    addSegment(1000, "Speaker 2", "Hi, I'm Priya.", "s2");
    addSegment(5, "Speaker 7", "an old upload line", null);

    const res = await request(app).get("/api/meetings/m1/speakers");

    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(
      (res.body.data as { key: string }[]).map((s) => [s.key, s])
    );
    expect(byKey.mic1).toMatchObject({ name: "You", isMe: true, segmentCount: 1 });
    expect(byKey.s2).toMatchObject({
      name: "Speaker 2",
      suggestion: { name: "Priya", signals: ["self_intro"] },
    });
    expect(byKey["label:Speaker 7"]).toMatchObject({ speakerId: null, segmentCount: 1 });
  });

  it("404s for an unknown meeting", async () => {
    expect((await request(app).get("/api/meetings/nope/speakers")).status).toBe(404);
  });
});

describe("PATCH /api/meetings/:id/speakers/:key", () => {
  it("renames a profile, its segments, and logs a SPEAKER correction with idx", async () => {
    db.profiles.push({ id: "s2", meetingId: "m1", label: "Speaker 2", displayName: null, centroid: [1], source: "DIARIZATION" });
    addSegment(1000, "Speaker 2", "on track", "s2");
    addSegment(1001, "Speaker 2", "next", "s2");

    const res = await request(app)
      .patch("/api/meetings/m1/speakers/s2")
      .send({ displayName: "  Priya  " });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ speakerId: "s2", name: "Priya", segments: 2 });
    expect(db.segments.map((s) => s.speaker)).toEqual(["Priya", "Priya"]);
    expect(db.profiles[0]).toMatchObject({ displayName: "Priya", source: "MANUAL" });
    expect(db.corrections).toEqual([
      {
        meetingId: "m1",
        kind: "SPEAKER",
        targetId: "s2",
        before: { speaker: "Speaker 2", label: "Speaker 2", idx: [1000, 1001] },
        after: { speaker: "Priya", label: "Speaker 2", idx: [1000, 1001], via: "manual" },
      },
    ]);
  });

  it("renames a legacy label by creating its profile and linking its segments", async () => {
    addSegment(0, "Speaker 1", "hello");
    addSegment(1, "Speaker 1", "again");
    addSegment(2, "Speaker 2", "other");

    const res = await request(app)
      .patch(`/api/meetings/m1/speakers/${encodeURIComponent("label:Speaker 1")}`)
      .send({ displayName: "Raj" });

    expect(res.status).toBe(200);
    expect(db.segments.map((s) => s.speaker)).toEqual(["Raj", "Raj", "Speaker 2"]);
    expect(db.profiles).toHaveLength(1);
    expect(db.segments[0].speakerId).toBe(db.profiles[0].id);
  });

  it("validates the name and the speaker", async () => {
    db.profiles.push({ id: "s2", meetingId: "m1", label: "Speaker 2", displayName: null, centroid: [], source: "DIARIZATION" });
    expect((await request(app).patch("/api/meetings/m1/speakers/s2").send({})).status).toBe(400);
    expect(
      (await request(app).patch("/api/meetings/m1/speakers/s2").send({ displayName: "x".repeat(61) })).status
    ).toBe(400);
    expect(
      (await request(app).patch("/api/meetings/m1/speakers/nope").send({ displayName: "A" })).status
    ).toBe(404);
  });
});

describe("POST /api/meetings/:id/speakers/:key/accept", () => {
  it("accepts the suggestion as a rename via 'suggestion'", async () => {
    db.profiles.push({ id: "s2", meetingId: "m1", label: "Speaker 2", displayName: null, centroid: [1], source: "DIARIZATION" });
    addSegment(1000, "Speaker 2", "Hi, I'm Priya.", "s2");

    const res = await request(app).post("/api/meetings/m1/speakers/s2/accept");

    expect(res.status).toBe(200);
    expect(db.segments[0].speaker).toBe("Priya");
    expect(db.corrections[0].after).toMatchObject({ speaker: "Priya", via: "suggestion" });
  });

  it("400s when there is nothing to accept", async () => {
    db.profiles.push({ id: "s2", meetingId: "m1", label: "Speaker 2", displayName: null, centroid: [1], source: "DIARIZATION" });
    addSegment(1000, "Speaker 2", "no names here", "s2");
    expect((await request(app).post("/api/meetings/m1/speakers/s2/accept")).status).toBe(400);
  });
});

describe("read-time names", () => {
  it("withSpeakerNames projects renames into the summary and tasks", async () => {
    db.profiles.push({ id: "s2", meetingId: "m1", label: "Speaker 2", displayName: null, centroid: [1], source: "DIARIZATION" });
    addSegment(1000, "Speaker 2", "I'll ship it", "s2");
    await request(app).patch("/api/meetings/m1/speakers/s2").send({ displayName: "Priya" });

    const meeting = {
      id: "m1",
      summary: {
        data: {
          actionItems: [
            { task: "Ship", owner: "Speaker 2", evidence: [{ idx: 1000, speaker: "Speaker 2" }] },
          ],
        },
      },
      actionItems: [{ meetingId: "m1", owner: "speaker 2" }],
    };

    const named = await withSpeakerNames(meeting);
    expect(named.summary.data.actionItems[0]).toMatchObject({
      owner: "Priya",
      evidence: [{ idx: 1000, speaker: "Priya" }],
    });
    expect(named.actionItems[0].owner).toBe("Priya");

    const items = await withOwnerNames([{ meetingId: "m1", owner: "Speaker 2" }]);
    expect(items[0].owner).toBe("Priya");
  });

  it("automatic names also project (label -> display name)", async () => {
    db.profiles.push({ id: "s3", meetingId: "m1", label: "Speaker 3", displayName: "Raj", centroid: [1], source: "DIARIZATION" });
    const items = await withOwnerNames([{ meetingId: "m1", owner: "Speaker 3" }]);
    expect(items[0].owner).toBe("Raj");
  });
});
