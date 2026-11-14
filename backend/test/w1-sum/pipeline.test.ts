import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/lib/env";
import {
  chunkByTokenBudget,
  runSummaryPipeline,
  type PipelineSegment,
} from "../../src/services/summary.service";
import type { SummaryV2 } from "../../src/types/summary";
import { calls, setScript, type RecordedCall } from "./helpers/fakeGemini";
import { evaluate, loadFixture, type Fixture } from "./helpers/fixtures";

vi.mock("../../src/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/gemini")>();
  const { fakeClient } = await import("./helpers/fakeGemini");
  return { ...actual, getClient: () => fakeClient };
});

/**
 * The v2 pipeline end to end on the synthetic fixtures, with a scripted
 * Gemini. The script plays a well-behaved model built from the answer
 * key, plus deliberate mistakes (citing small talk, hallucinated ids) so
 * the code guards are what the assertions exercise.
 */

// Monday 9 November 2026, 10:00 New York.
const MEETING_START = new Date("2026-11-09T15:00:00Z");
const TIMEZONE = "America/New_York";

/** Segments by startMs that a sensible CLEAN pass labels as noise. */
const NOISE: Record<string, Record<number, string>> = {
  "project-meeting": {
    0: "logistics",
    4400: "small_talk",
    10800: "small_talk",
    16200: "logistics",
    46800: "small_talk",
    141000: "small_talk",
    145400: "small_talk",
    149800: "small_talk",
  },
  lecture: {
    0: "small_talk",
    7400: "small_talk",
    114600: "off_topic",
    124000: "logistics",
    126400: "logistics",
    152000: "logistics",
  },
};

const cleanFor = (fixture: Fixture) => (call: RecordedCall) => {
  const noise = NOISE[fixture.name];
  const startByIdx = new Map(fixture.segments.map((s) => [s.idx, s.startMs]));

  return {
    labels: call.ids.map((idx) => ({
      idx,
      label: noise[startByIdx.get(idx) ?? -1] ?? "substantive",
    })),
  };
};

const item = (fields: Record<string, unknown>, evidence: number[], confidence = 0.8) => ({
  ...fields,
  evidence,
  confidence,
});

/**
 * EXTRACT as an obedient model: emits each answer-key item whose
 * evidence is in its input, citing only those ids. `extra` adds items
 * a careless model might produce.
 */
const extractFor =
  (fixture: Fixture, extra: (fixture: Fixture) => Record<string, unknown[]> = () => ({})) =>
  (call: RecordedCall) => {
    const present = new Set(call.ids);
    const body: Record<string, unknown> = {
      tldr: `Summary of ${fixture.name}. It covered the agenda. Next steps were agreed. This fourth sentence is cut.`,
      keyPoints: [],
      decisions: [],
      actionItems: [],
      dates: [],
      openQuestions: [],
      whoSaidWhat: [],
      glossary: [],
      nextSessionPrep: [],
      keywords: ["search", "postgres"],
      sentiment: { overall: "POSITIVE", rationale: "Productive." },
    };
    const lecture = {
      outline: [] as unknown[],
      definitions: [] as unknown[],
      formulas: [],
      examQuestions: { flaggedByLecturer: [] as unknown[], likely: [] },
      assignments: [] as unknown[],
      studyChecklist: [],
    };

    for (const expected of fixture.mustAppear) {
      const ids = expected.evidenceStartMs
        .map((ms) => fixture.idxByStart.get(ms) as number)
        .filter((idx) => present.has(idx));
      if (!ids.length) continue;

      const text = expected.match.join(" ");

      switch (expected.kind) {
        case "decision":
          (body.decisions as unknown[]).push(item({ text: `Use ${text} search for v1`, decidedBy: "Priya" }, ids));
          break;
        case "actionItem":
          (body.actionItems as unknown[]).push(
            item(
              {
                task: `Do the ${text}`,
                owner: expected.owner,
                assignedBy: expected.owner === "Priya" ? null : "Priya",
                dueSpoken: expected.dueDate ? `by ${expected.dueDate}` : null,
                priority: "medium",
              },
              ids
            )
          );
          break;
        case "openQuestion":
          (body.openQuestions as unknown[]).push(item({ text: `Day one or behind a ${text}?` }, ids));
          break;
        case "examTopic":
          lecture.examQuestions.flaggedByLecturer.push(
            item({ question: `Explain ${text}.`, reason: "Lecturer: this will be on the exam." }, ids, 0.95)
          );
          break;
        case "definition":
          lecture.definitions.push(item({ term: text, definition: "Maps a key to a bucket index." }, ids));
          break;
        case "homework":
          lecture.assignments.push(
            item({ task: `Implement a ${text} with separate chaining`, dueSpoken: "next Tuesday before class" }, ids)
          );
          break;
      }
    }

    for (const [key, values] of Object.entries(extra(fixture))) {
      (body[key] as unknown[]).push(...values);
    }

    if (fixture.mode === "LECTURE") body.sections = { lecture };
    if (fixture.mode === "PROJECT") {
      body.sections = {
        project: {
          people: [
            { name: "Marcus", done: [item({ text: "Benchmarked Postgres" }, [fixture.idxByStart.get(36400) as number])], next: [], blockers: [] },
            { name: "Ghost", done: [], next: [], blockers: [] },
          ],
          risks: [],
        },
      };
    }

    return body;
  };

/** Mistakes a careless model makes in a project meeting. */
const projectMistakes = (fixture: Fixture) => ({
  // Cites the Rust joke, which CLEAN labelled small talk.
  actionItems: [item({ task: "Rewrite the indexer in Rust", owner: "Tom", assignedBy: null, dueSpoken: null, priority: "LOW" }, [fixture.idxByStart.get(46800) as number])],
  // Cites the lunch chat.
  dates: [item({ spoken: "Thursday", description: "Team lunch" }, [fixture.idxByStart.get(141000) as number])],
  // Hallucinated id.
  keyPoints: [item({ text: "The coffee machine is broken" }, [99999])],
});

const runFixture = async (fixture: Fixture, overrides: Partial<Parameters<typeof runSummaryPipeline>[1]> = {}) =>
  runSummaryPipeline(fixture.segments, {
    modeSetting: fixture.mode,
    meetingStart: MEETING_START,
    timezone: TIMEZONE,
    ...overrides,
  });

/** Every evidence object anywhere in the summary. */
const allEvidence = (summary: SummaryV2) => {
  const found: { idx: number; speaker: string; startMs: number }[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "evidence" && Array.isArray(value)) found.push(...value);
        else walk(value);
      }
    }
  };
  walk(summary);
  return found;
};

describe("summary pipeline on project-meeting.json", () => {
  const fixture = loadFixture("project-meeting");

  beforeEach(() =>
    setScript({ clean: cleanFor(fixture), extract: extractFor(fixture, projectMistakes) })
  );

  it("finds every expected item with correct evidence, owner and deadline", async () => {
    const { summary } = await runFixture(fixture);
    const result = evaluate(summary, fixture);

    expect(result.missing).toEqual([]);
    expect(result.wrongEvidence).toEqual([]);
    expect(result.wrongDetails).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("cites only real, substantive segments", async () => {
    const { summary, labels } = await runFixture(fixture);
    const evidence = allEvidence(summary);
    const byIdx = new Map(fixture.segments.map((s) => [s.idx, s]));

    expect(evidence.length).toBeGreaterThan(0);
    for (const entry of evidence) {
      const segment = byIdx.get(entry.idx);
      expect(segment).toBeDefined();
      expect(labels.get(entry.idx)).toBe("substantive");
      // speaker and startMs come from the segment, not the model.
      expect(entry.speaker).toBe(segment?.speaker);
      expect(entry.startMs).toBe(segment?.startMs);
    }
    expect(summary.stats.droppedItems).toBe(3);
  });

  it("keeps small talk out of EXTRACT's input entirely", async () => {
    await runFixture(fixture);
    const noiseIdx = Object.keys(NOISE["project-meeting"]).map(
      (ms) => fixture.idxByStart.get(Number(ms)) as number
    );
    const extractIds = calls.filter((c) => c.step === "extract").flatMap((c) => c.ids);

    expect(extractIds.length).toBeGreaterThan(0);
    for (const idx of noiseIdx) expect(extractIds).not.toContain(idx);
  });

  it("resolves spoken deadlines in code from the meeting start", async () => {
    const { summary } = await runFixture(fixture);
    const due = Object.fromEntries(summary.actionItems.map((a) => [a.owner + ":" + a.task, [a.dueSpoken, a.dueDate]]));

    expect(due["Marcus:Do the endpoint"]).toEqual(["by Friday", "2026-11-13"]);
    expect(due["Lena:Do the results page"]).toEqual(["by end of next week", "2026-11-20"]);
    expect(due["Tom:Do the test plan"]).toEqual(["by tomorrow", "2026-11-10"]);
    expect(due["Marcus:Do the migration"]).toEqual([null, null]);
    expect(due["Priya:Do the announcement"]).toEqual([null, null]);
  });

  it("runs every call at temperature 0, CLEAN on the cheap model", async () => {
    await runFixture(fixture);

    expect(calls.map((c) => c.step)).toEqual(["clean", "extract", "verify"]);
    for (const call of calls) expect(call.temperature).toBe(0);
    expect(calls[0].model).toBe(env.geminiCleanModel);
    expect(calls[1].model).toBe(env.geminiModel);
    expect(calls[1].system).toContain("This session is a PROJECT meeting");
  });

  it("caps the tldr at three sentences and drops empty people", async () => {
    const { summary, markdown } = await runFixture(fixture);

    expect(summary.tldr).toBe(
      "Summary of project-meeting. It covered the agenda. Next steps were agreed."
    );
    expect(summary.sections.project?.people.map((p) => p.name)).toEqual(["Marcus"]);
    expect(markdown).toContain("# TL;DR (Project)");
    expect(markdown).toContain("by Friday (2026-11-13)");
  });

  it("records schema version, mode and prompt versions", async () => {
    const { summary } = await runFixture(fixture);

    expect(summary.schemaVersion).toBe(2);
    expect(summary.mode).toBe("PROJECT");
    expect(summary.modeSetting).toBe("PROJECT");
    expect(summary.detectedMode).toBeNull();
    expect(summary.prompts).toEqual({
      clean: "clean.v1",
      extract: "extract.v1",
      verify: "verify.v1",
      mode: "mode.project.v1",
    });
  });

  it("map-reduces when the transcript exceeds the token budget", async () => {
    const { summary } = await runFixture(fixture, { tokenBudget: 120 });
    const steps = calls.map((c) => c.step);

    expect(steps.filter((s) => s === "extract").length).toBeGreaterThan(1);
    expect(steps).toContain("reduce");
    expect(summary.stats.chunks).toBeGreaterThan(1);

    const result = evaluate(summary, fixture);
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("hands CLEAN labels to the injected writer", async () => {
    const writer = vi.fn(async () => {});
    await runFixture(fixture, { writeNoiseLabels: writer });

    expect(writer).toHaveBeenCalledTimes(1);
    const labels = (writer.mock.calls[0] as unknown[])[0] as { idx: number; label: string }[];
    expect(labels).toHaveLength(fixture.segments.length);
    expect(labels.find((l) => l.idx === fixture.idxByStart.get(4400))?.label).toBe("small_talk");
  });

  it("does not fail the summary when the writer fails", async () => {
    const { summary } = await runFixture(fixture, {
      writeNoiseLabels: async () => {
        throw new Error("db down");
      },
    });
    expect(summary.actionItems.length).toBe(5);
  });

  it("skips CLEAN for segments that already have a label", async () => {
    const labelled: PipelineSegment[] = fixture.segments.map((s) => ({
      ...s,
      noiseLabel: NOISE["project-meeting"][s.startMs] ?? "substantive",
    }));
    const { summary } = await runSummaryPipeline(labelled, {
      modeSetting: "PROJECT",
      meetingStart: MEETING_START,
      timezone: TIMEZONE,
    });

    expect(calls.map((c) => c.step)).toEqual(["extract", "verify"]);
    expect(summary.prompts.clean).toBeUndefined();
    expect(evaluate(summary, fixture).violations).toEqual([]);
  });

  it("marks low-confidence items as needing review", async () => {
    setScript({
      clean: cleanFor(fixture),
      extract: extractFor(fixture),
      verify: (_call, draft) => {
        const out = JSON.parse(JSON.stringify(draft));
        out.actionItems = out.actionItems.map((a: { task: string }) => ({
          ...a,
          confidence: a.task.includes("migration") ? 0.4 : 0.92,
        }));
        return out;
      },
    });
    const { summary } = await runFixture(fixture);
    const review = summary.actionItems.filter((a) => a.needsReview).map((a) => a.task);

    expect(review).toEqual(["Do the migration"]);
  });

  it("lets VERIFY drop an unsupported item", async () => {
    setScript({
      clean: cleanFor(fixture),
      extract: extractFor(fixture),
      verify: (_call, draft) => ({
        ...draft,
        actionItems: (draft.actionItems as { task: string }[]).filter((a) => !a.task.includes("announcement")),
      }),
    });
    const { summary } = await runFixture(fixture);

    expect(summary.actionItems.map((a) => a.task)).not.toContain("Do the announcement");
  });

  it("keeps an unverified draft, flagged for review, when VERIFY fails", async () => {
    setScript({
      clean: cleanFor(fixture),
      extract: extractFor(fixture),
      fail: { verify: new Error("internal error") },
    });
    const { summary } = await runFixture(fixture);

    expect(summary.actionItems.length).toBe(5);
    expect(summary.actionItems.every((a) => a.needsReview)).toBe(true);
  });

  it("treats everything as substantive when CLEAN fails", async () => {
    const writer = vi.fn(async () => {});
    setScript({
      extract: extractFor(fixture),
      fail: { clean: new Error("internal error") },
    });
    const { labels } = await runFixture(fixture, { writeNoiseLabels: writer });

    expect([...labels.values()].every((l) => l === "substantive")).toBe(true);
    expect(writer).not.toHaveBeenCalled();
  });
});

describe("summary pipeline on lecture.json (sparse live-style idx)", () => {
  // seq * 1000 + i with five segments per chunk: 0..4, 1000..1004, ...
  const fixture = loadFixture("lecture", (p) => Math.floor(p / 5) * 1000 + (p % 5));

  const lectureMistakes = (f: Fixture) => ({
    keyPoints: [item({ text: "Hash tables are the duct tape of computer science" }, [f.idxByStart.get(114600) as number])],
  });

  beforeEach(() =>
    setScript({
      clean: cleanFor(fixture),
      extract: extractFor(fixture, lectureMistakes),
      classify: () => ({ mode: "LECTURE", confidence: 0.93, reason: "One person teaching hash tables." }),
    })
  );

  it("finds both exam questions the lecturer flagged, with their segments", async () => {
    const { summary } = await runFixture(fixture);
    const flagged = summary.sections.lecture?.examQuestions.flaggedByLecturer ?? [];

    expect(flagged).toHaveLength(2);
    expect(flagged.map((q) => q.evidence[0].startMs).sort((a, b) => a - b)).toEqual([65200, 105200]);
    expect(flagged.map((q) => q.evidence[0].idx).sort((a, b) => a - b)).toEqual([
      fixture.idxByStart.get(65200),
      fixture.idxByStart.get(105200),
    ]);

    const result = evaluate(summary, fixture);
    expect(result.missing).toEqual([]);
    expect(result.wrongEvidence).toEqual([]);
    expect(result.wrongDetails).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("uses sparse idx values, never array positions", async () => {
    const { summary } = await runFixture(fixture);
    const valid = new Set(fixture.segments.map((s) => s.idx));

    for (const entry of allEvidence(summary)) expect(valid.has(entry.idx)).toBe(true);
    expect(allEvidence(summary).some((e) => e.idx >= 1000)).toBe(true);
  });

  it("resolves the homework deadline", async () => {
    const { summary } = await runFixture(fixture);
    const homework = summary.sections.lecture?.assignments[0];

    expect(homework?.dueSpoken).toBe("next Tuesday before class");
    expect(homework?.dueDate).toBe("2026-11-17");
  });

  it("classifies an AUTO meeting and records the guess", async () => {
    const { summary } = await runFixture(fixture, { modeSetting: "AUTO" });

    expect(calls[0].step).toBe("classify");
    expect(calls[0].model).toBe(env.geminiCleanModel);
    expect(summary.modeSetting).toBe("AUTO");
    expect(summary.mode).toBe("LECTURE");
    expect(summary.detectedMode).toEqual({
      mode: "LECTURE",
      confidence: 0.93,
      reason: "One person teaching hash tables.",
    });
    expect(summary.prompts.classify).toBe("classify.v1");
    expect(summary.prompts.mode).toBe("mode.lecture.v1");
  });

  it("falls back to GENERAL when CLASSIFY returns nonsense", async () => {
    setScript({
      clean: cleanFor(fixture),
      extract: extractFor(fixture),
      classify: () => ({ mode: "PODCAST", confidence: "high" }),
    });
    const { summary } = await runFixture(fixture, { modeSetting: "AUTO" });

    expect(summary.mode).toBe("GENERAL");
    expect(summary.detectedMode?.confidence).toBe(0.5);
    expect(summary.sections).toEqual({});
  });
});

describe("pipeline edge cases", () => {
  beforeEach(() => setScript({}));

  it("rejects an empty transcript", async () => {
    await expect(
      runSummaryPipeline([], { modeSetting: "GENERAL", meetingStart: MEETING_START })
    ).rejects.toThrow(/no transcript segments/);
  });

  it("makes no EXTRACT call when nothing is substantive", async () => {
    setScript({
      clean: (call) => ({ labels: call.ids.map((idx) => ({ idx, label: "small_talk" })) }),
    });
    const { summary } = await runSummaryPipeline(
      [{ idx: 0, speaker: "A", text: "Nice weather!", startMs: 0, endMs: 1000 }],
      { modeSetting: "GENERAL", meetingStart: MEETING_START }
    );

    expect(calls.map((c) => c.step)).toEqual(["clean"]);
    expect(summary.tldr).toMatch(/No substantive discussion/);
    expect(summary.actionItems).toEqual([]);
  });

  it("chunks by token budget without splitting a segment", () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({
      idx: i * 1000,
      speaker: "A",
      text: "x".repeat(200),
      startMs: i * 1000,
      endMs: i * 1000 + 900,
    }));

    const chunks = chunkByTokenBudget(segments, 120);
    expect(chunks.flat()).toHaveLength(10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunkByTokenBudget(segments, 10)).toHaveLength(10);
  });
});
