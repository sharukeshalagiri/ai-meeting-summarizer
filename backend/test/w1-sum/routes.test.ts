import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { sortByDueDate } from "../../src/services/actionItem.service";
import {
  effectiveModeSetting,
  reviewedActionItems,
} from "../../src/services/w1-sum.service";
import { setScript } from "./helpers/fakeGemini";

/**
 * The w1-sum endpoints through the real routes, controller and
 * service, with repositories as in-memory fakes and Gemini scripted.
 */

const store = vi.hoisted(() => ({
  meeting: null as null | Record<string, unknown>,
  segments: [] as Record<string, unknown>[],
  corrections: [] as { kind: string; targetId: string | null; before: unknown; after: unknown }[],
  items: [] as Record<string, unknown>[],
  summary: null as null | { content: string; data: unknown; sentiment: string },
  replaceCalls: [] as { items: { task: string }[]; options: unknown }[],
}));

vi.mock("../../src/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/gemini")>();
  const { fakeClient } = await import("./helpers/fakeGemini");
  return { ...actual, getClient: () => fakeClient };
});

vi.mock("../../src/repositories/meeting.repository", () => ({
  updateMode: async (_id: string, mode: string) => {
    if (store.meeting) store.meeting.mode = mode;
  },
  findById: async (id: string) =>
    store.meeting && store.meeting.id === id
      ? { ...store.meeting, summary: store.summary, actionItems: store.items }
      : null,
}));

vi.mock("../../src/repositories/segment.repository", () => ({
  findByMeetingId: async () => store.segments,
  setNoiseLabels: async (_meetingId: string, labels: { idx: number; label: string }[]) => {
    for (const { idx, label } of labels) {
      const row = store.segments.find((segment) => segment.idx === idx);
      if (row) row.noiseLabel = label;
    }
    return labels.length;
  },
}));

vi.mock("../../src/repositories/correction.repository", () => ({
  findByMeetingId: async () => store.corrections,
  record: async (input: { kind: string; targetId?: string | null; before: unknown; after: unknown }) => {
    const row = { ...input, targetId: input.targetId ?? null };
    store.corrections.push(row);
    return row;
  },
}));

vi.mock("../../src/repositories/summary.repository", () => ({
  upsert: async (meetingId: string, content: string, data: unknown, sentiment: string) => {
    store.summary = { content, data, sentiment };
    return { id: "s1", meetingId, ...store.summary };
  },
}));

vi.mock("../../src/repositories/actionItem.repository", () => ({
  findById: async (id: string) => store.items.find((item) => item.id === id) ?? null,
  findByMeetingId: async () => store.items,
  replaceForMeeting: async (_meetingId: string, items: { task: string }[], options: unknown) => {
    store.replaceCalls.push({ items, options });
    return items.length;
  },
  updateReviewed: async (id: string, data: Record<string, unknown>) => {
    const row = store.items.find((item) => item.id === id) as Record<string, unknown>;
    Object.assign(row, data, { needsReview: false });
    return row;
  },
  deleteById: async (id: string) => {
    store.items = store.items.filter((item) => item.id !== id);
  },
}));

const app = createApp();

beforeEach(() => {
  store.meeting = {
    id: "m1",
    mode: "AUTO",
    startedAt: new Date("2026-11-09T15:00:00Z"),
    createdAt: new Date("2026-11-09T15:00:00Z"),
  };
  store.segments = [
    { idx: 3000, speaker: "Priya", text: "Marcus, build the endpoint by Friday.", startMs: 0, endMs: 3000, noiseLabel: null },
    { idx: 3001, speaker: "Marcus", text: "Will do.", startMs: 3000, endMs: 4000, noiseLabel: null },
  ];
  store.corrections = [];
  store.summary = null;
  store.replaceCalls = [];
  store.items = [
    {
      id: "a1",
      meetingId: "m1",
      task: "Build the endpoint",
      owner: "Marcus",
      dueSpoken: "by Friday",
      dueDate: "2026-11-13",
      priority: "MEDIUM",
      confidence: 0.4,
      evidence: [{ idx: 3000, speaker: "Priya", startMs: 0 }],
      needsReview: true,
    },
  ];

  setScript({
    classify: () => ({ mode: "PROJECT", confidence: 0.7, reason: "Planning." }),
    extract: () => ({
      tldr: "Endpoint planned.",
      actionItems: [
        { task: "Build the endpoint", owner: "Marcus", assignedBy: "Priya", dueSpoken: "by Friday", priority: "HIGH", evidence: [3000, 3001], confidence: 0.9 },
      ],
      sections: { project: { people: [], risks: [] } },
    }),
  });
});

describe("w1-sum routes", () => {
  it("re-summarizes from stored segments with their idx", async () => {
    const res = await request(app).post("/api/meetings/m1/resummarize").send({ timezone: "America/New_York" });

    expect(res.status).toBe(200);
    const data = store.summary?.data as { schemaVersion: number; mode: string; detectedMode: { mode: string }; actionItems: { dueDate: string; evidence: { idx: number }[] }[] };
    expect(data.schemaVersion).toBe(2);
    expect(data.mode).toBe("PROJECT");
    expect(data.detectedMode.mode).toBe("PROJECT");
    expect(data.actionItems[0].dueDate).toBe("2026-11-13");
    expect(data.actionItems[0].evidence.map((e) => e.idx)).toEqual([3000, 3001]);
    expect(store.summary?.content).toContain("# TL;DR");
    expect(store.replaceCalls[0].items[0]).toMatchObject({ task: "Build the endpoint", dueSpoken: "by Friday", assignedBy: "Priya", needsReview: false });
    // Wiring: the producing pipeline is recorded, and CLEAN labels are
    // stored through segment.repository setNoiseLabels by default.
    expect((store.summary?.data as { pipeline?: string }).pipeline).toBe("v2");
    expect(store.segments.map((s) => s.noiseLabel)).not.toContain(null);
  });

  it("records a mode change as a correction and uses it", async () => {
    const res = await request(app).patch("/api/meetings/m1/mode").send({ mode: "lecture" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ modeSetting: "LECTURE" });
    expect(store.meeting?.mode).toBe("LECTURE");
    expect(store.corrections).toEqual([
      { meetingId: "m1", kind: "MEETING_MODE", targetId: null, before: { mode: "AUTO" }, after: { mode: "LECTURE" } },
    ]);

    const review = await request(app).get("/api/meetings/m1/summary-review");
    expect(review.body.data.modeSetting).toBe("LECTURE");
  });

  it("rejects an unknown mode", async () => {
    const res = await request(app).patch("/api/meetings/m1/mode").send({ mode: "podcast" });
    expect(res.status).toBe(400);
  });

  it("rejects a bad timezone", async () => {
    const res = await request(app).post("/api/meetings/m1/resummarize").send({ timezone: "Mars/Base" });
    expect(res.status).toBe(400);
  });

  it("refuses to re-summarize without segments", async () => {
    store.segments = [];
    const res = await request(app).post("/api/meetings/m1/resummarize").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown meeting", async () => {
    const res = await request(app).get("/api/meetings/nope/summary-review");
    expect(res.status).toBe(404);
  });

  it("accepts an action item", async () => {
    const res = await request(app).post("/api/meetings/m1/action-items/a1/review").send({ action: "accept" });

    expect(res.status).toBe(200);
    expect(store.items[0].needsReview).toBe(false);
    expect(store.corrections[0]).toMatchObject({ kind: "ACTION_ITEM", targetId: "a1", after: { action: "accept" } });
    expect((store.corrections[0].before as { evidence: { idx: number }[] }).evidence[0].idx).toBe(3000);
  });

  it("edits an action item and re-resolves its deadline", async () => {
    const res = await request(app)
      .post("/api/meetings/m1/action-items/a1/review")
      .send({ action: "edit", task: "Build the search endpoint", dueSpoken: "tomorrow", timezone: "America/New_York" });

    expect(res.status).toBe(200);
    expect(store.items[0]).toMatchObject({ task: "Build the search endpoint", dueSpoken: "tomorrow", dueDate: "2026-11-10" });
    expect(store.corrections[0].after).toMatchObject({ action: "edit", task: "Build the search endpoint", dueDate: "2026-11-10" });
  });

  it("rejects an action item", async () => {
    const res = await request(app).post("/api/meetings/m1/action-items/a1/review").send({ action: "reject" });

    expect(res.status).toBe(200);
    expect(store.items).toHaveLength(0);
    expect(store.corrections[0]).toMatchObject({ after: { action: "reject" }, before: { task: "Build the endpoint" } });
  });

  it("validates the review action and the item's meeting", async () => {
    expect((await request(app).post("/api/meetings/m1/action-items/a1/review").send({ action: "maybe" })).status).toBe(400);
    expect((await request(app).post("/api/meetings/other/action-items/a1/review").send({ action: "accept" })).status).toBe(404);
  });

  it("keeps reviewed items when re-summarizing", async () => {
    await request(app).post("/api/meetings/m1/action-items/a1/review").send({ action: "edit", task: "Ship search" });
    await request(app).post("/api/meetings/m1/resummarize").send({});

    expect(store.replaceCalls[0].options).toEqual({ keepIds: ["a1"], suppressTasks: ["Build the endpoint"] });
  });
});

describe("w1-sum helpers", () => {
  it("lets the latest mode correction win over Meeting.mode", () => {
    expect(effectiveModeSetting("PROJECT", [])).toBe("PROJECT");
    expect(effectiveModeSetting("weird", [])).toBe("AUTO");
    expect(
      effectiveModeSetting("AUTO", [
        { kind: "MEETING_MODE", after: { mode: "LECTURE" } },
        { kind: "ACTION_ITEM", after: { action: "accept" } },
        { kind: "MEETING_MODE", after: { mode: "INTERVIEW" } },
      ])
    ).toBe("INTERVIEW");
  });

  it("derives kept and suppressed items from corrections", () => {
    expect(
      reviewedActionItems([
        { kind: "ACTION_ITEM", targetId: "a", before: { task: "A" }, after: { action: "accept" } },
        { kind: "ACTION_ITEM", targetId: "b", before: { task: "B" }, after: { action: "edit" } },
        { kind: "ACTION_ITEM", targetId: "c", before: { task: "C" }, after: { action: "reject" } },
        { kind: "SPEAKER", targetId: "d", before: { task: "D" }, after: { action: "reject" } },
      ])
    ).toEqual({ keepIds: ["a", "b"], suppressTasks: ["B", "C"] });
  });

  it("sorts tasks: open first, by due date, undated and free text last", () => {
    const rows = [
      { id: "done", status: "COMPLETED", dueDate: "2026-11-01", createdAt: "2026-11-01" },
      { id: "legacy", status: "PENDING", dueDate: "Friday", createdAt: "2026-11-05" },
      { id: "late", status: "PENDING", dueDate: "2026-11-20", createdAt: "2026-11-01" },
      { id: "soon", status: "PENDING", dueDate: "2026-11-10", createdAt: "2026-11-01" },
      { id: "none", status: "PENDING", dueDate: null, createdAt: "2026-11-02" },
    ];

    expect(sortByDueDate(rows).map((r) => r.id)).toEqual(["soon", "late", "legacy", "none", "done"]);
  });
});
