import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPrompt,
  computeSinceLastTime,
  parseVerdicts,
  type EarlierItem,
  type SinceSegment,
} from "../../src/services/series/sinceLastTime";

/**
 * "Since last time": no real Gemini call anywhere; the judge is a stub
 * that returns what a model might, including invalid output.
 */

const items: EarlierItem[] = [
  { id: "ai-1", task: "Send the budget draft", owner: "Priya", dueSpoken: "by Friday", meeting: { id: "m1", title: "Week 1", createdAt: new Date("2026-11-01") } },
  { id: "ai-2", task: "Book the venue", owner: "Sam", dueSpoken: null, meeting: { id: "m1", title: "Week 1", createdAt: new Date("2026-11-01") } },
  { id: "ai-3", task: "Fix the login bug", owner: null, dueSpoken: null, meeting: { id: "m2", title: "Week 2", createdAt: new Date("2026-11-08") } },
];

const segments: SinceSegment[] = [
  { idx: 0, speaker: "Priya", text: "I sent the budget draft yesterday.", startMs: 1000, noiseLabel: "substantive" },
  { idx: 1, speaker: "Sam", text: "How was everyone's weekend?", startMs: 4000, noiseLabel: "small_talk" },
  { idx: 2, speaker: "Sam", text: "The venue is still not booked, waiting on a quote.", startMs: 9000, noiseLabel: null },
];

const meeting = { id: "m3", userId: "alice", seriesId: "s1", createdAt: new Date("2026-11-15") };

describe("parseVerdicts", () => {
  const valid = new Set([0, 2]);

  it("keeps valid verdicts and fills the gaps with not_mentioned", () => {
    const out = parseVerdicts(
      { verdicts: [{ n: 1, status: "done", evidence: [0], note: "sent yesterday" }, { n: 2, status: "still_open", evidence: [2] }] },
      3,
      valid
    );
    expect(out.map((v) => v.status)).toEqual(["done", "still_open", "not_mentioned"]);
    expect(out[0].evidence).toEqual([0]);
  });

  it("drops invented segment ids and distrusts 'done' without evidence", () => {
    const out = parseVerdicts({ verdicts: [{ n: 1, status: "done", evidence: [99, 1] }] }, 1, valid);
    expect(out[0]).toMatchObject({ status: "still_open", evidence: [] });
  });

  it("ignores out-of-range numbers, duplicates, bad statuses and garbage", () => {
    const out = parseVerdicts(
      { verdicts: [{ n: 0, status: "done" }, { n: 4, status: "done" }, { n: 1, status: "maybe" }, { n: 1, status: "done", evidence: [0] }, "x"] },
      3,
      valid
    );
    expect(out.map((v) => v.status)).toEqual(["not_mentioned", "not_mentioned", "not_mentioned"]);
    expect(parseVerdicts(null, 2, valid)).toHaveLength(2);
  });
});

describe("computeSinceLastTime", () => {
  const judge = vi.fn();
  const earlierItems = vi.fn();

  beforeEach(() => {
    judge.mockReset();
    earlierItems.mockReset().mockResolvedValue(items);
  });

  it("makes no model call when the meeting is not in a series", async () => {
    expect(await computeSinceLastTime({ ...meeting, seriesId: null }, segments, { judge, earlierItems })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
    expect(earlierItems).not.toHaveBeenCalled();
  });

  it("makes no model call when nothing earlier is open", async () => {
    earlierItems.mockResolvedValue([]);
    expect(await computeSinceLastTime(meeting, segments, { judge, earlierItems })).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it("asks only about the series' earlier items, without small talk, and suggests COMPLETED for done", async () => {
    judge.mockResolvedValue({
      verdicts: [
        { n: 1, status: "done", evidence: [0], note: "I sent the budget draft yesterday" },
        { n: 2, status: "still_open", evidence: [2], note: "waiting on a quote" },
        { n: 3, status: "not_mentioned", evidence: [] },
      ],
    });

    const result = await computeSinceLastTime(meeting, segments, { judge, earlierItems });

    expect(earlierItems).toHaveBeenCalledWith(
      expect.objectContaining({ seriesId: "s1", userId: "alice", meetingId: "m3", before: meeting.createdAt })
    );
    const prompt = judge.mock.calls[0][0] as string;
    expect(prompt).toContain("1. Send the budget draft (owner: Priya) (due: by Friday)");
    expect(prompt).toContain("[#0] Priya:");
    expect(prompt).not.toContain("weekend");

    expect(result!.items.map((i) => [i.actionItemId, i.status, i.suggestedStatus])).toEqual([
      ["ai-1", "done", "COMPLETED"],
      ["ai-2", "still_open", null],
      ["ai-3", "not_mentioned", null],
    ]);
    expect(result!.items[0].evidence).toEqual([{ idx: 0, startMs: 1000, speaker: "Priya" }]);
    expect(result!.items.every((i) => i.resolution === null)).toBe(true);
  });

  it("buildPrompt caps a very long transcript", () => {
    const long = Array.from({ length: 5000 }, (_, idx) => ({ idx, speaker: "S", text: "x".repeat(40), startMs: idx }));
    expect(buildPrompt(items, long).length).toBeLessThan(70_000);
  });
});
