import { describe, expect, it } from "vitest";
import { acceptBaseline, checkOutcome, compare, EXIT, type Baseline } from "../src/baseline";
import { applyProposals, matchTerms, proposeFromCorrections } from "../src/corrections";
import { flattenSummary } from "../src/items";
import { buildJudgeRequest, judgePrompt, parseJudgeResponse } from "../src/judge";
import type { Metrics } from "../src/report";
import type { ProducedItem } from "../src/types";
import { fixture, idxAt } from "./helpers";

const project = fixture("project-meeting");

describe("judge", () => {
  const produced: ProducedItem[] = [
    { ref: "decisions[0]", kind: "decision", text: "Use the database's built-in text search", evidence: [idxAt(project.segments, 68800)] },
    { ref: "actionItems[0]", kind: "actionItem", text: "Build the search endpoint", owner: "Marcus", evidence: [idxAt(project.segments, 76200)] },
    { ref: "keyPoints[0]", kind: "other", text: "Quarterly revenue doubled", evidence: [idxAt(project.segments, 76200)] },
    { ref: "actionItems[1]", kind: "actionItem", text: "Bring umbrellas because of the rain", evidence: [1] },
  ];

  it("asks only about what string matching could not settle", () => {
    const request = buildJudgeRequest("p", project.key, project.segments, produced);
    // The decision did not match on words; the endpoint task did.
    const decision = request.pairs.find((p) => p.expectedId === "decision-postgres-fts");
    expect(decision?.candidates.map((c) => c.ref)).toEqual(["decisions[0]"]);
    expect(request.pairs.some((p) => p.expectedId === "task-search-endpoint")).toBe(false);
    // A trap item is never offered as a rescue candidate.
    expect(request.pairs.flatMap((p) => p.candidates.map((c) => c.ref))).not.toContain("actionItems[1]");
    expect(request.support.map((s) => s.ref)).toContain("keyPoints[0]");
    expect(judgePrompt([request])).toContain("EXPECTED decision-postgres-fts");
  });

  it("keeps only verdicts about what was offered", () => {
    const request = buildJudgeRequest("p", project.key, project.segments, produced);
    const verdicts = parseJudgeResponse(
      {
        matches: [
          { caseId: "p", expectedId: "decision-postgres-fts", ref: "decisions[0]" },
          { caseId: "p", expectedId: "task-search-endpoint", ref: "keyPoints[0]" },
          { caseId: "zzz", expectedId: "x", ref: "y" },
        ],
        unsupported: [{ caseId: "p", ref: "keyPoints[0]" }, { caseId: "p", ref: "invented[9]" }],
      },
      [request]
    );
    expect(verdicts.get("p")).toEqual({ matches: [{ expectedId: "decision-postgres-fts", ref: "decisions[0]" }], unsupported: ["keyPoints[0]"] });
    expect(parseJudgeResponse("garbage", [request]).get("p")).toEqual({ matches: [], unsupported: [] });
  });
});

describe("flattenSummary", () => {
  it("maps summary fields to answer-key kinds", () => {
    const ev = [{ idx: 3, speaker: "x", startMs: 0 }];
    const s = { confidence: 1, needsReview: false, evidence: ev };
    const summary = {
      tldr: "t",
      actionItems: [{ ...s, task: "Do it", owner: "Ann", assignedBy: null, dueSpoken: "Friday", dueDate: "2026-11-13", priority: "HIGH" }],
      decisions: [{ ...s, text: "Decided", decidedBy: null }],
      openQuestions: [],
      dates: [{ ...s, spoken: "December 4th", date: "2026-12-04", description: "board" }],
      keyPoints: [{ ...s, text: "kp" }],
      whoSaidWhat: [],
      glossary: [],
      nextSessionPrep: [],
      sections: {
        lecture: { outline: [], definitions: [{ ...s, term: "hash", definition: "d" }], formulas: [], examQuestions: { flaggedByLecturer: [{ ...s, question: "q", reason: "r" }], likely: [{ ...s, question: "l", reason: "r" }] }, assignments: [{ ...s, task: "hw", dueSpoken: "next Tuesday", dueDate: null }], studyChecklist: [] },
      },
    };
    const items = flattenSummary(summary as never);
    const kinds = Object.fromEntries(items.map((i) => [i.ref, i.kind]));
    expect(kinds).toMatchObject({
      "actionItems[0]": "actionItem",
      "decisions[0]": "decision",
      "dates[0]": "date",
      "lecture.definitions[0]": "definition",
      "lecture.examQuestions.flaggedByLecturer[0]": "examTopic",
      "lecture.assignments[0]": "homework",
      "keyPoints[0]": "other",
      "sections.lecture.examQuestions.likely[0]": "other",
    });
    const task = items.find((i) => i.ref === "actionItems[0]")!;
    expect(task).toMatchObject({ owner: "Ann", dueSpoken: "Friday", dueDate: "2026-11-13", evidence: [3] });
    // The resolved date is not part of the matching text; the spoken one is.
    expect(task.text).toContain("Friday");
    expect(task.text).not.toContain("2026");
    expect(items.find((i) => i.ref === "dates[0]")).toMatchObject({ dueSpoken: "December 4th", dueDate: "2026-12-04" });
  });
});

describe("corrections -> proposed expectations", () => {
  const key = { transcript: "t", mode: "general", mustAppear: [], mustNotAppear: [] };
  const before = { task: "Renew the company domain", owner: "Jo", dueSpoken: "today", dueDate: "2026-11-09T00:00:00.000Z", evidence: [{ idx: 10, speaker: "Jo", startMs: 41000 }] };

  it("turns accept, edit, reject and mode changes into proposals", () => {
    const proposals = proposeFromCorrections(key, [
      { id: "c1", kind: "ACTION_ITEM", before, after: { action: "accept" } },
      { id: "c2", kind: "ACTION_ITEM", before: { ...before, task: "Order pizza for lunch" }, after: { action: "reject" } },
      { id: "c3", kind: "MEETING_MODE", before: { mode: "AUTO" }, after: { mode: "ONE_ON_ONE" } },
      { id: "c4", kind: "SPEAKER", before: {}, after: {} },
    ]);
    expect(proposals.map((p) => p.type)).toEqual(["addMustAppear", "addMustNotAppear", "setMode", "ignored"]);
    const next = applyProposals(key, proposals);
    expect(next.mode).toBe("one-on-one");
    expect(next.mustAppear[0]).toMatchObject({ kind: "actionItem", owner: "Jo", dueDate: "today", dueResolved: "2026-11-09", evidenceStartMs: [41000] });
    expect(next.mustNotAppear[0]).toMatchObject({ kind: "actionItem", match: ["order", "pizza"] });
    // Original key untouched until --write applies it.
    expect(key.mustAppear).toHaveLength(0);
  });

  it("an edit updates the matching expected item instead of adding one", () => {
    const withTask = { ...key, mustAppear: [{ id: "task-domain", kind: "actionItem", match: ["domain"], owner: "Jo", dueDate: "today", evidenceStartMs: [41000] }] };
    const [proposal] = proposeFromCorrections(withTask, [{ id: "c5", kind: "ACTION_ITEM", before, after: { action: "edit", owner: "Pat" } }]);
    expect(proposal).toMatchObject({ type: "updateMustAppear", id: "task-domain", item: { owner: "Pat", match: ["domain"] } });
  });

  it("picks the two longest distinctive words as match terms", () => {
    expect(matchTerms("I'll renew the company domain today")).toEqual(["company", "domain"]);
  });
});

const metrics = (headline: Partial<Metrics["headline"]>, infraShare = 0): Metrics =>
  ({
    infraShare,
    headline: { taskRecallFull: null, taskPrecision: null, hallucinationRate: null, trapHitRate: null, examRecall: null, dateAccuracy: null, werMicro: null, der2: null, meRecall: null, ...headline },
  }) as Metrics;

describe("regression gate", () => {
  const baseline: Baseline = { status: "accepted", metrics: { taskRecallFull: 0.8, hallucinationRate: 0.05 }, tolerances: {} };

  it("passes within tolerance and fails beyond it, in the right direction", () => {
    expect(checkOutcome(metrics({ taskRecallFull: 0.75, hallucinationRate: 0.08 }), compare(metrics({ taskRecallFull: 0.75, hallucinationRate: 0.08 }), baseline)).exit).toBe(EXIT.ok);
    const worse = metrics({ taskRecallFull: 0.65, hallucinationRate: 0.05 });
    const outcome = checkOutcome(worse, compare(worse, baseline));
    expect(outcome.exit).toBe(EXIT.regressed);
    expect(outcome.summary).toContain("taskRecallFull");
    const moreHallucination = metrics({ taskRecallFull: 0.8, hallucinationRate: 0.2 });
    expect(checkOutcome(moreHallucination, compare(moreHallucination, baseline)).exit).toBe(EXIT.regressed);
  });

  it("is inconclusive when more than 25% of cases were outages", () => {
    const m = metrics({ taskRecallFull: 0.1 }, 0.3);
    expect(checkOutcome(m, compare(m, baseline)).exit).toBe(EXIT.inconclusive);
  });

  it("treats a placeholder baseline as nothing to compare", () => {
    const m = metrics({ taskRecallFull: 0.5 });
    const outcome = checkOutcome(m, compare(m, { status: "placeholder", metrics: {}, tolerances: {} }));
    expect(outcome.exit).toBe(EXIT.ok);
    expect(outcome.summary).toContain("nothing compared");
  });

  it("accept keeps unmeasured metrics and existing tolerances", () => {
    const next = acceptBaseline(metrics({ taskRecallFull: 0.9 }), { ...baseline, tolerances: { taskRecallFull: 0.2 } }, "2026-11-15", "first run", new Date("2026-11-15T00:00:00Z"));
    expect(next.metrics).toMatchObject({ taskRecallFull: 0.9, hallucinationRate: 0.05 });
    expect(next.tolerances.taskRecallFull).toBe(0.2);
    expect(next.tolerances.hallucinationRate).toBe(0.05);
    expect(next).toMatchObject({ status: "accepted", note: "first run", report: "2026-11-15" });
  });
});
