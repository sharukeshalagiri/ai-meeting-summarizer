import { describe, expect, it } from "vitest";
import { parseStructuredSummary } from "../../src/services/summary.service";
import {
  asConfidence,
  asEvidenceIds,
  parseNoiseLabels,
  parseSummaryBody,
} from "../../src/services/w1-sum.parsers";
import {
  isSummaryV2,
  normalizeModeSetting,
  toJsonValueV2,
  type SummaryV2,
} from "../../src/types/summary";

const ev = (idx: number, startMs = idx * 1000) => ({ idx, speaker: "Priya", startMs });

const storedV2: SummaryV2 = {
  schemaVersion: 2,
  mode: "PROJECT",
  modeSetting: "AUTO",
  detectedMode: { mode: "PROJECT", confidence: 0.8, reason: "Stand-up." },
  tldr: "The team chose Postgres.",
  keyPoints: [{ text: "Benchmarks favour Postgres", evidence: [ev(6)], confidence: 0.9, needsReview: false }],
  decisions: [{ text: "Use Postgres FTS", decidedBy: "Priya", evidence: [ev(12)], confidence: 0.95, needsReview: false }],
  actionItems: [
    {
      task: "Build the endpoint",
      owner: "Marcus",
      assignedBy: "Priya",
      dueSpoken: "by Friday",
      dueDate: "2026-11-13",
      priority: "HIGH",
      evidence: [ev(13)],
      confidence: 0.9,
      needsReview: false,
    },
  ],
  dates: [{ spoken: "Friday", date: "2026-11-13", description: "Endpoint due", evidence: [ev(13)], confidence: 0.9, needsReview: false }],
  openQuestions: [{ text: "Flag or day one?", evidence: [ev(23)], confidence: 0.7, needsReview: false }],
  whoSaidWhat: [],
  glossary: [],
  nextSessionPrep: [{ text: "Check with sales", evidence: [ev(24)], confidence: 0.6, needsReview: false }],
  keywords: ["postgres"],
  sentiment: { overall: "POSITIVE", rationale: "Upbeat." },
  sections: {
    project: {
      people: [{ name: "Tom", done: [], next: [], blockers: [{ text: "No staging DB", evidence: [ev(9)], confidence: 0.8, needsReview: false }] }],
      risks: [{ text: "Beta slip", evidence: [ev(10)], confidence: 0.5, needsReview: true }],
    },
  },
  prompts: { extract: "extract.v1" },
  stats: { segments: 28, substantiveSegments: 20, chunks: 1, droppedItems: 0, timezone: "UTC", meetingStart: "2026-11-09T15:00:00.000Z" },
};

describe("summary schema versions", () => {
  it("still parses a version 1 row unchanged", () => {
    const v1 = {
      executiveSummary: "Old summary.",
      keyDecisions: ["A"],
      actionItems: [{ task: "T", owner: null, dueDate: "Friday", priority: "LOW" }],
      importantDates: [],
      followUps: [],
    };

    const parsed = parseStructuredSummary(v1);
    expect(parsed.executiveSummary).toBe("Old summary.");
    expect(parsed.actionItems[0].dueDate).toBe("Friday");
    expect(parsed.risks).toEqual([]);
    expect(isSummaryV2(v1)).toBe(false);
  });

  it("projects a version 2 row onto the version 1 shape for analytics", () => {
    const stored = JSON.parse(JSON.stringify(toJsonValueV2(storedV2)));
    expect(isSummaryV2(stored)).toBe(true);

    const legacy = parseStructuredSummary(stored);
    expect(legacy.executiveSummary).toBe("The team chose Postgres.");
    expect(legacy.keyDecisions).toEqual(["Use Postgres FTS"]);
    expect(legacy.actionItems).toEqual([
      { task: "Build the endpoint", owner: "Marcus", dueDate: "by Friday", priority: "HIGH" },
    ]);
    expect(legacy.importantDates).toEqual([{ date: "Friday", description: "Endpoint due" }]);
    expect(legacy.blockers).toEqual(["No staging DB"]);
    expect(legacy.risks).toEqual(["Beta slip"]);
    expect(legacy.followUps).toEqual(["Check with sales"]);
    expect(legacy.sentiment.overall).toBe("POSITIVE");
    expect(legacy.discussionTopics[0].summary).toBe("Benchmarks favour Postgres");
  });

  it("rejects a version 2 row with an empty tldr like an empty v1 row", () => {
    expect(() => parseStructuredSummary({ ...storedV2, tldr: "" } as unknown as Record<string, unknown>)).toThrow();
  });

  it("normalizes mode spellings", () => {
    expect(normalizeModeSetting("lecture")).toBe("LECTURE");
    expect(normalizeModeSetting("one-on-one")).toBe("ONE_ON_ONE");
    expect(normalizeModeSetting("ONE_ON_ONE")).toBe("ONE_ON_ONE");
    expect(normalizeModeSetting("auto")).toBe("AUTO");
    expect(normalizeModeSetting("podcast")).toBeNull();
    expect(normalizeModeSetting(3)).toBeNull();
  });
});

describe("pipeline parsers", () => {
  it("reads evidence ids leniently and drops junk", () => {
    expect(asEvidenceIds([3, "4", "#5", 3, -1, 2.5, "x", null])).toEqual([3, 4, 5]);
    expect(asEvidenceIds("3")).toEqual([]);
  });

  it("clamps confidence and treats junk as unsure", () => {
    expect(asConfidence(0.7)).toBe(0.7);
    expect(asConfidence(85)).toBe(0.85);
    expect(asConfidence(-2)).toBe(0);
    expect(asConfidence("0.3")).toBe(0.3);
    expect(asConfidence(undefined)).toBe(0.5);
  });

  it("labels skipped or unknown CLEAN entries as substantive", () => {
    const labels = parseNoiseLabels(
      { labels: [{ idx: 1, label: "small_talk" }, { idx: 2, label: "music" }, { idx: 99, label: "filler" }, "junk"] },
      [1, 2, 3]
    );

    expect([...labels.entries()]).toEqual([
      [1, "small_talk"],
      [2, "substantive"],
      [3, "substantive"],
    ]);
  });

  it("drops malformed items and defaults missing sections", () => {
    const body = parseSummaryBody(
      {
        tldr: "  Short.  ",
        actionItems: [
          { task: "", evidence: [1] },
          { task: "Ship it", owner: "null", assignedBy: "Ana", dueSpoken: "N/A", priority: "high", evidence: [1] },
          { task: "Self", owner: "Ana", assignedBy: "ana", evidence: [2] },
          42,
        ],
        decisions: "not a list",
        sections: { lecture: { outline: [] }, project: { people: [] } },
      },
      "PROJECT"
    );

    expect(body.tldr).toBe("Short.");
    expect(body.actionItems).toEqual([
      expect.objectContaining({ task: "Ship it", owner: null, assignedBy: "Ana", dueSpoken: null, priority: "HIGH", evidence: [1] }),
      expect.objectContaining({ task: "Self", owner: "Ana", assignedBy: null }),
    ]);
    expect(body.decisions).toEqual([]);
    expect(body.keyPoints).toEqual([]);
    expect(body.sentiment).toEqual({ overall: "NEUTRAL", rationale: "" });
    // Only the active mode's section is read.
    expect(body.sections).toEqual({ project: { people: [], risks: [] } });
  });
});
