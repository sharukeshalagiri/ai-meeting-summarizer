import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";

/**
 * Speaker renames reach the summary and the tasks (read-time
 * projection): after "Speaker 2" is renamed to Priya, every response
 * that serves summary evidence or action-item owners shows Priya, while
 * the stored summary and action items keep the old label.
 */

type Item = {
  id: string;
  meetingId: string;
  task: string;
  owner: string | null;
  assignedBy: string | null;
  dueDate: string | null;
  dueSpoken: string | null;
  priority: string;
  status: string;
  needsReview: boolean;
  confidence: number | null;
  evidence: { idx: number; speaker: string; startMs: number }[];
  createdAt: Date;
};

const db = vi.hoisted(() => ({
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
    startMs: number;
    endMs: number;
    noiseLabel: string | null;
  }[],
  corrections: [] as {
    meetingId: string;
    kind: string;
    targetId: string | null;
    before: unknown;
    after: unknown;
  }[],
  summary: null as null | { meetingId: string; content: string; data: Record<string, unknown> },
  items: [] as Item[],
  n: 0,
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  exists: async (id: string) => id === "m1",
  findById: async (id: string) =>
    id === "m1"
      ? {
          id: "m1",
          title: "Weekly sync",
          mode: "AUTO",
          createdAt: new Date("2026-11-14T10:00:00Z"),
          startedAt: null,
          summary: db.summary,
          actionItems: db.items.map((item) => ({ ...item })),
        }
      : null,
}));

vi.mock("../../src/repositories/summary.repository", () => ({
  findByMeetingId: async (id: string) => (id === "m1" ? db.summary : null),
}));

vi.mock("../../src/repositories/actionItem.repository", () => ({
  findByMeetingId: async (id: string) =>
    db.items.filter((item) => item.meetingId === id).map((item) => ({ ...item })),
  findAll: async () => db.items.map((item) => ({ ...item })),
  findById: async (id: string) => db.items.find((item) => item.id === id) ?? null,
  updateReviewed: async (id: string, data: Partial<Item>) => {
    const item = db.items.find((row) => row.id === id)!;
    Object.assign(item, data, { needsReview: false });
    return { ...item };
  },
}));

vi.mock("../../src/repositories/liveSession.repository", () => ({
  findByMeetingId: async () => null,
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

vi.mock("../../src/repositories/export.repository", () => ({
  findForExport: async (id: string) =>
    id === "m1"
      ? {
          title: "Weekly sync",
          createdAt: new Date("2026-11-14T10:00:00Z"),
          startedAt: new Date("2026-11-14T10:00:00Z"),
          durationSec: 600,
          mode: "PROJECT",
          series: null,
          summary: db.summary ? { data: db.summary.data } : null,
          actionItems: db.items.map(({ task, owner, dueDate, dueSpoken, status, needsReview }) => ({
            task,
            owner,
            dueDate,
            dueSpoken,
            status,
            needsReview,
          })),
          user: { email: "alice@example.com", name: "Alice", displayName: null, timezone: "UTC" },
        }
      : null,
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

const evidence = [{ idx: 1, speaker: "Speaker 2", startMs: 5000 }];

beforeEach(() => {
  db.profiles = [];
  db.corrections = [];
  db.n = 0;
  db.segments = [
    { idx: 0, speaker: "You", channel: "mic", text: "Can someone own the budget?", startMs: 0, endMs: 4000 },
    { idx: 1, speaker: "Speaker 2", channel: "remote", text: "I'll send the draft by Friday.", startMs: 5000, endMs: 9000 },
  ].map((s) => ({ ...s, meetingId: "m1", speakerId: null, noiseLabel: null }));
  db.summary = {
    meetingId: "m1",
    content: "Budget draft due Friday.",
    data: {
      schemaVersion: 2,
      mode: "PROJECT",
      tldr: "Budget draft due Friday.",
      keyPoints: [{ text: "The budget draft is due Friday", evidence, confidence: 0.9, needsReview: false }],
      decisions: [],
      actionItems: [{ task: "Send the budget draft", owner: "Speaker 2", evidence }],
      dates: [],
      openQuestions: [],
      whoSaidWhat: [{ speaker: "Speaker 2", points: ["Owns the budget draft"] }],
      glossary: [],
      nextSessionPrep: [],
      keywords: [],
      sentiment: { overall: "NEUTRAL", rationale: "" },
      sections: {},
    },
  };
  db.items = [
    {
      id: "a1",
      meetingId: "m1",
      task: "Send the budget draft",
      owner: "Speaker 2",
      assignedBy: "You",
      dueDate: null,
      dueSpoken: "by Friday",
      priority: "MEDIUM",
      status: "PENDING",
      needsReview: true,
      confidence: 0.9,
      evidence,
      createdAt: new Date("2026-11-14T10:10:00Z"),
    },
  ];
});

const renameToPriya = async () => {
  const res = await request(app)
    .patch(`/api/meetings/m1/speakers/${encodeURIComponent("label:Speaker 2")}`)
    .send({ displayName: "Priya" });
  expect(res.status).toBe(200);
};

type Named = { owner: string | null; evidence: { idx: number; speaker: string }[] };

const expectPriya = (item: Named) => {
  expect(item.owner).toBe("Priya");
  expect(item.evidence[0]).toMatchObject({ idx: 1, speaker: "Priya" });
};

describe("speaker renames reach the summary and tasks", () => {
  it("before a rename, responses carry the stored labels", async () => {
    const res = await request(app).get("/api/meetings/m1");
    expect(res.body.data.actionItems[0].owner).toBe("Speaker 2");
    expect(res.body.data.summary.data.actionItems[0].owner).toBe("Speaker 2");
  });

  it("GET /meetings/:id: summary evidence, summary tasks and action items", async () => {
    await renameToPriya();

    const { data } = (await request(app).get("/api/meetings/m1")).body;
    expectPriya(data.actionItems[0]);
    expectPriya(data.summary.data.actionItems[0]);
    expect(data.summary.data.keyPoints[0].evidence[0].speaker).toBe("Priya");
    expect(data.summary.data.whoSaidWhat[0].speaker).toBe("Priya");
    // The user's own lines and free text are untouched.
    expect(data.actionItems[0].assignedBy).toBe("You");
    expect(data.summary.data.tldr).toBe("Budget draft due Friday.");
  });

  it("GET /meetings/:id/summary and /action-items", async () => {
    await renameToPriya();

    const summary = (await request(app).get("/api/meetings/m1/summary")).body.data;
    expectPriya(summary.data.actionItems[0]);

    const items = (await request(app).get("/api/meetings/m1/action-items")).body.data;
    expectPriya(items[0]);
  });

  it("GET /summary-review and GET /action-items (all meetings)", async () => {
    await renameToPriya();

    const review = (await request(app).get("/api/meetings/m1/summary-review")).body.data;
    expectPriya(review.actionItems[0]);

    const all = (await request(app).get("/api/action-items")).body.data;
    expectPriya(all[0]);
  });

  it("a mutation response: accepting an action item returns it with current names", async () => {
    await renameToPriya();

    const res = await request(app)
      .post("/api/meetings/m1/action-items/a1/review")
      .send({ action: "accept" });
    expect(res.status).toBe(200);
    expectPriya(res.body.data);
  });

  it("exports use the current name", async () => {
    await renameToPriya();

    const res = await request(app).get("/api/meetings/m1/export?format=md");
    expect(res.status).toBe(200);
    expect(res.text).toContain("owner: Priya");
    expect(res.text).not.toContain("Speaker 2");
  });

  it("stored data is not rewritten", async () => {
    await renameToPriya();
    await request(app).get("/api/meetings/m1");

    expect(db.items[0].owner).toBe("Speaker 2");
    expect((db.summary!.data.actionItems as Named[])[0].owner).toBe("Speaker 2");
  });
});
