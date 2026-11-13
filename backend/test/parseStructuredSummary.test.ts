import { describe, expect, it } from "vitest";
import { parseStructuredSummary } from "../src/services/summary.service";
import { AppError } from "../src/types/errors";

const full = {
  executiveSummary: "  The team agreed on the launch plan.  ",
  keyDecisions: ["Ship on Postgres", "  ", 42],
  actionItems: [
    {
      task: "Write the migration",
      owner: "Priya",
      dueDate: "next Friday",
      priority: "HIGH",
    },
  ],
  importantDates: [{ date: "March 3", description: "Beta launch" }],
  followUps: ["Revisit pricing"],
  risks: ["Vendor delay"],
  blockers: ["No staging DB"],
  openQuestions: ["Who owns on-call?"],
  discussionTopics: [{ topic: "Launch", summary: "Dates were set." }],
  keywords: ["postgres", "launch"],
  sentiment: { overall: "POSITIVE", rationale: "Upbeat." },
};

describe("parseStructuredSummary", () => {
  it("parses a complete model response from a JSON string", () => {
    const result = parseStructuredSummary(JSON.stringify(full));

    expect(result.executiveSummary).toBe(
      "The team agreed on the launch plan."
    );
    expect(result.actionItems).toEqual([
      {
        task: "Write the migration",
        owner: "Priya",
        dueDate: "next Friday",
        priority: "HIGH",
      },
    ]);
    expect(result.importantDates).toEqual([
      { date: "March 3", description: "Beta launch" },
    ]);
    expect(result.sentiment).toEqual({
      overall: "POSITIVE",
      rationale: "Upbeat.",
    });
  });

  it("drops non-string and blank entries from string lists", () => {
    const result = parseStructuredSummary(full);

    expect(result.keyDecisions).toEqual(["Ship on Postgres"]);
  });

  it("reads a legacy five-field row with empty defaults", () => {
    const legacy = {
      executiveSummary: "Old summary.",
      keyDecisions: ["A"],
      actionItems: [],
      importantDates: [],
      followUps: [],
    };

    const result = parseStructuredSummary(legacy);

    expect(result.risks).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.openQuestions).toEqual([]);
    expect(result.discussionTopics).toEqual([]);
    expect(result.keywords).toEqual([]);
    expect(result.sentiment).toEqual({ overall: "NEUTRAL", rationale: "" });
  });

  it("normalizes action items: blanks to null, bad priority to MEDIUM", () => {
    const result = parseStructuredSummary({
      executiveSummary: "x",
      actionItems: [
        { task: " Deploy ", owner: "  ", dueDate: null, priority: "URGENT" },
        { task: "", owner: "Sam" },
        { owner: "No task" },
        "not an object",
        null,
      ],
    });

    expect(result.actionItems).toEqual([
      { task: "Deploy", owner: null, dueDate: null, priority: "MEDIUM" },
    ]);
  });

  it("falls back to NEUTRAL for an unknown sentiment", () => {
    const result = parseStructuredSummary({
      executiveSummary: "x",
      sentiment: { overall: "ECSTATIC", rationale: 5 },
    });

    expect(result.sentiment).toEqual({ overall: "NEUTRAL", rationale: "" });
  });

  it("drops dates and topics without their key field", () => {
    const result = parseStructuredSummary({
      executiveSummary: "x",
      importantDates: [{ description: "no date" }, { date: "Monday" }],
      discussionTopics: [{ summary: "no topic" }, { topic: "Budget" }],
    });

    expect(result.importantDates).toEqual([
      { date: "Monday", description: "" },
    ]);
    expect(result.discussionTopics).toEqual([
      { topic: "Budget", summary: "" },
    ]);
  });

  it("rejects an empty executive summary with a 502", () => {
    expect(() =>
      parseStructuredSummary({ ...full, executiveSummary: "   " })
    ).toThrowError(AppError);

    try {
      parseStructuredSummary({ keyDecisions: [] });
    } catch (error) {
      expect((error as AppError).status).toBe(502);
    }
  });

  it("rejects unparseable JSON with a 502", () => {
    expect.assertions(2);

    try {
      parseStructuredSummary("{not json");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(502);
    }
  });

  it("rejects JSON that is not an object", () => {
    expect(() => parseStructuredSummary("null")).toThrowError(AppError);
    expect(() => parseStructuredSummary('"text"')).toThrowError(AppError);
  });
});
