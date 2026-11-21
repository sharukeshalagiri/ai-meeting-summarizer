import { beforeEach, describe, expect, it, vi } from "vitest";
import * as access from "../../src/repositories/access.repository";
import * as actionItemRepo from "../../src/repositories/actionItem.repository";
import * as correctionRepo from "../../src/repositories/correction.repository";
import * as summaryRepo from "../../src/repositories/summary.repository";
import { resolveSuggestion, setMeetingSeries } from "../../src/services/series/series.service";

/** Confirming "Since last time" suggestions, and linking meetings. */

vi.mock("../../src/repositories/summary.repository", () => ({
  findByMeetingId: vi.fn(),
  updateData: vi.fn(async () => ({})),
}));
vi.mock("../../src/repositories/actionItem.repository", () => ({
  updateStatus: vi.fn(async (id: string, status: string) => ({ id, status })),
}));
vi.mock("../../src/repositories/correction.repository", () => ({ record: vi.fn(async () => ({})) }));
vi.mock("../../src/repositories/series.repository", () => ({
  findOwned: vi.fn(async (id: string, userId: string) => (id === "s-alice" && userId === "alice" ? { id, name: "Weekly" } : null)),
  findByName: vi.fn(async () => null),
  create: vi.fn(async (_userId: string, name: string) => ({ id: "s-new", name })),
  setMeetingSeries: vi.fn(async () => ({ count: 1 })),
}));

const since = (resolution: string | null = null) => ({
  version: 1,
  seriesId: "s-alice",
  generatedAt: "2026-11-15T00:00:00.000Z",
  items: [
    {
      actionItemId: "ai-1",
      task: "Send the budget draft",
      owner: "Priya",
      dueSpoken: null,
      fromMeeting: { id: "m1", title: "Week 1", createdAt: "2026-11-01T00:00:00.000Z" },
      status: "done",
      note: null,
      evidence: [{ idx: 3002, startMs: 61000, speaker: "Priya" }],
      suggestedStatus: "COMPLETED",
      resolution,
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(summaryRepo.findByMeetingId).mockResolvedValue({ data: { tldr: "x", sinceLastTime: since() } } as never);
  vi.mocked(access.actionItemOwnerId).mockResolvedValue("alice");
});

describe("resolveSuggestion", () => {
  it("apply marks the earlier item COMPLETED, records a correction and the resolution", async () => {
    const result = await resolveSuggestion({ userId: "alice", meetingId: "m3", actionItemId: "ai-1", action: "apply" });

    expect(actionItemRepo.updateStatus).toHaveBeenCalledWith("ai-1", "COMPLETED", expect.any(Date));
    expect(result.item.resolution).toBe("applied");
    const saved = vi.mocked(summaryRepo.updateData).mock.calls[0][1] as { tldr: string; sinceLastTime: ReturnType<typeof since> };
    expect(saved.tldr).toBe("x");
    expect(saved.sinceLastTime.items[0].resolution).toBe("applied");
    expect(correctionRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "SINCE_LAST_TIME", targetId: "ai-1", after: expect.objectContaining({ evidence: [3002] }) })
    );
  });

  it("dismiss changes no task", async () => {
    const result = await resolveSuggestion({ userId: "alice", meetingId: "m3", actionItemId: "ai-1", action: "dismiss" });
    expect(actionItemRepo.updateStatus).not.toHaveBeenCalled();
    expect(result.item.resolution).toBe("dismissed");
  });

  it("is idempotent once resolved", async () => {
    vi.mocked(summaryRepo.findByMeetingId).mockResolvedValue({ data: { sinceLastTime: since("applied") } } as never);
    const result = await resolveSuggestion({ userId: "alice", meetingId: "m3", actionItemId: "ai-1", action: "apply" });
    expect(result.alreadyResolved).toBe(true);
    expect(actionItemRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("never touches a task of another account", async () => {
    vi.mocked(access.actionItemOwnerId).mockResolvedValue("bob");
    await expect(
      resolveSuggestion({ userId: "alice", meetingId: "m3", actionItemId: "ai-1", action: "apply" })
    ).rejects.toMatchObject({ status: 404 });
    expect(actionItemRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("404s for an unknown item", async () => {
    await expect(
      resolveSuggestion({ userId: "alice", meetingId: "m3", actionItemId: "nope", action: "dismiss" })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("setMeetingSeries", () => {
  it("links to an own series, creates one by name, and refuses another account's", async () => {
    expect(await setMeetingSeries("alice", "m1", { seriesId: "s-alice", name: null })).toEqual({ meetingId: "m1", seriesId: "s-alice" });
    expect(await setMeetingSeries("alice", "m1", { seriesId: null, name: "  Project   sync " })).toEqual({ meetingId: "m1", seriesId: "s-new" });
    await expect(setMeetingSeries("alice", "m1", { seriesId: "s-bob", name: null })).rejects.toMatchObject({ status: 404 });
    expect(await setMeetingSeries("alice", "m1", { seriesId: null, name: null })).toEqual({ meetingId: "m1", seriesId: null });
  });
});
