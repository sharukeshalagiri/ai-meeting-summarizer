import { describe, expect, it } from "vitest";
import { scoreSummary } from "../src/score";
import type { ProducedItem } from "../src/types";
import { fixture, idxAt } from "./helpers";

const project = fixture("project-meeting");
const at = (ms: number) => idxAt(project.segments, ms);

/** A perfect answer to the project-meeting key. */
const perfect = (): ProducedItem[] => [
  { ref: "decisions[0]", kind: "decision", text: "Use Postgres full-text search", evidence: [at(68800)] },
  { ref: "actionItems[0]", kind: "actionItem", text: "Build the search endpoint", owner: "Marcus", dueSpoken: "by Friday", dueDate: "2026-11-13", evidence: [at(76200)] },
  { ref: "actionItems[1]", kind: "actionItem", text: "Build the results page", owner: "Lena", dueSpoken: "by the end of next week", dueDate: "2026-11-20", evidence: [at(90400)] },
  { ref: "actionItems[2]", kind: "actionItem", text: "Write the test plan", owner: "Tom", dueSpoken: "tomorrow", dueDate: "2026-11-10", evidence: [at(105200)] },
  { ref: "actionItems[3]", kind: "actionItem", text: "Write the migration", owner: "Marcus", dueSpoken: null, dueDate: null, evidence: [at(116000)] },
  { ref: "actionItems[4]", kind: "actionItem", text: "Send the announcement email", owner: "Priya", dueSpoken: null, dueDate: null, evidence: [at(126800)] },
  { ref: "openQuestions[0]", kind: "openQuestion", text: "Day one or behind a flag?", evidence: [at(131200)] },
];

describe("scoreSummary", () => {
  it("gives full marks to a perfect summary", () => {
    const score = scoreSummary({ ...project, produced: perfect(), tldr: "Search plan locked. Five tasks." });
    expect(score.mustAppear).toMatchObject({ total: 7, found: 7 });
    expect(score.tasks).toEqual({ expected: 5, foundText: 5, foundFull: 5, produced: 5, truePositive: 5 });
    expect(score.dates.correct).toBe(score.dates.total);
    expect(score.traps.hit).toEqual([]);
    expect(score.citations).toEqual({ checked: 7, correct: 7 });
    expect(score.hallucination.trapItems).toBe(0);
    expect(score.tldr).toEqual({ words: 5, sentences: 2 });
  });

  it("separates text recall from full recall (owner, date)", () => {
    const produced = perfect();
    produced[2] = { ...produced[2], owner: "Marcus" }; // the results page is Lena's
    produced[3] = { ...produced[3], dueDate: "2026-11-11" }; // wrong resolution of "tomorrow"
    const score = scoreSummary({ ...project, produced, tldr: "" });
    expect(score.tasks.foundText).toBe(5);
    expect(score.tasks.foundFull).toBe(3);
    expect(score.dates.correct).toBe(score.dates.total - 1);
  });

  it("counts extra tasks against precision and traps as hallucinations", () => {
    const produced: ProducedItem[] = [
      ...perfect(),
      { ref: "actionItems[5]", kind: "actionItem", text: "Ship dark mode", owner: null, dueSpoken: null, dueDate: null, evidence: [0] },
      { ref: "keyPoints[0]", kind: "other", text: "Marcus got caught in the rain", evidence: [1] },
    ];
    const score = scoreSummary({ ...project, produced, tldr: "" });
    expect(score.tasks.truePositive).toBe(5);
    expect(score.tasks.produced).toBe(6);
    expect(score.traps.hit.sort()).toEqual(["parked-dark-mode", "smalltalk-rain"]);
    expect(score.hallucination.trapItems).toBe(2);
  });

  it("uses the judge's rescued matches and unsupported verdicts", () => {
    const produced = perfect();
    produced[0] = { ...produced[0], text: "Go with the database's built-in text search" };
    produced.push({ ref: "keyPoints[0]", kind: "other", text: "Budget approved for Elasticsearch", evidence: [at(68800)] });
    const without = scoreSummary({ ...project, produced, tldr: "" });
    expect(without.mustAppear.found).toBe(6);
    expect(without.judged).toBe(false);

    const withJudge = scoreSummary({
      ...project,
      produced,
      tldr: "",
      verdict: { matches: [{ expectedId: "decision-postgres-fts", ref: "decisions[0]" }], unsupported: ["keyPoints[0]"] },
    });
    expect(withJudge.mustAppear.found).toBe(7);
    expect(withJudge.hallucination.judgedUnsupported).toBe(1);
  });

  it("reports count violations (no-tasks expects zero tasks)", () => {
    const noTasks = fixture("no-tasks");
    const score = scoreSummary({
      ...noTasks,
      produced: [{ ref: "actionItems[0]", kind: "actionItem", text: "Clean up the dashboard", evidence: [7] }],
      tldr: "",
    });
    expect(score.counts).toEqual([{ kind: "actionItem", expected: 0, actual: 1 }]);
    expect(score.tasks).toMatchObject({ produced: 1, truePositive: 0 });
    expect(score.traps.hit).toContain("not-a-task-dashboard");
  });
});
