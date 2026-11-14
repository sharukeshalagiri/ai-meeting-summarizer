import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUDGE_SYSTEM } from "../src/judge";
import { classifyAttempt, estimateSummaryCalls, runEval, toPipelineSegments } from "../src/run";
import type { LoadedCase } from "../src/types";
import { fixture, idxAt } from "./helpers";

/**
 * The real pipeline (runSummaryPipeline) runs against a fake Gemini:
 * requests are answered by `send`, never sent. Proves the harness
 * counts, classifies and scores without the network.
 */

const project = fixture("project-meeting");
const at = (ms: number) => idxAt(project.segments, ms);

const projectCase = (): LoadedCase => ({
  entry: { id: "project-meeting", type: "synthetic", meetingStart: "2026-11-09T15:00:00Z", timezone: "America/New_York", priority: 0 },
  key: project.key,
  segments: project.segments,
  durationMs: 140_000,
});

const body = {
  tldr: "The team chose Postgres full-text search and split the work.",
  keyPoints: [],
  decisions: [{ text: "Use Postgres full-text search", decidedBy: "Priya", evidence: [at(68800)], confidence: 0.9 }],
  actionItems: [
    { task: "Build the search endpoint", owner: "Marcus", dueSpoken: "by Friday", evidence: [at(76200)], confidence: 0.9, priority: "HIGH" },
    { task: "Build the results page", owner: "Lena", dueSpoken: "by the end of next week", evidence: [at(90400)], confidence: 0.9, priority: "MEDIUM" },
    { task: "Write the test plan", owner: "Tom", dueSpoken: "tomorrow", evidence: [at(105200)], confidence: 0.9, priority: "MEDIUM" },
    { task: "Write the migration", owner: "Marcus", dueSpoken: null, evidence: [at(116000)], confidence: 0.9, priority: "MEDIUM" },
    { task: "Send the announcement email", owner: "Priya", dueSpoken: null, evidence: [at(126800)], confidence: 0.9, priority: "LOW" },
  ],
  dates: [],
  openQuestions: [{ text: "Launch on day one or behind a flag?", evidence: [at(131200)], confidence: 0.8 }],
  whoSaidWhat: [],
  glossary: [],
  nextSessionPrep: [],
  keywords: ["search"],
  sentiment: { overall: "POSITIVE", rationale: "" },
  sections: {},
};

const respond = (json: unknown) => ({ text: JSON.stringify(json), usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } });

/** Answers by request type; `fail` can inject errors per step. */
const fakeGemini = (fail: (step: string, n: number) => Error | null = () => null) => {
  const seen: Record<string, number> = {};
  const send = vi.fn(async (params: Record<string, unknown>) => {
    const contents = String(params.contents);
    const system = String((params.config as Record<string, unknown>)?.systemInstruction ?? "");
    const step = system === JUDGE_SYSTEM ? "judge" : contents.startsWith("Label every segment") ? "clean" : contents.startsWith("Draft summary") ? "verify" : "extract";
    seen[step] = (seen[step] ?? 0) + 1;
    const error = fail(step, seen[step]);
    if (error) throw error;
    if (step === "clean") return respond({ labels: [] });
    if (step === "judge") return respond({ matches: [], unsupported: [] });
    return respond(body);
  });
  return { send, seen };
};

const unavailable = () => new Error("503 UNAVAILABLE: high demand");

beforeEach(() => {
  // withRetry waits 1.5 s and 3 s between attempts; tests do not.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
});
afterEach(() => vi.restoreAllMocks());

const base = { cap: 30, judge: true, diarize: false, retryWaitMs: 0, sleep: async () => {} };

describe("runEval with a fake Gemini", () => {
  it("runs the real pipeline, resolves dates in code and scores the case", async () => {
    const { send, seen } = fakeGemini();
    const run = await runEval({ ...base, cases: [projectCase()], send });

    const result = run.cases[0];
    expect(result.status).toBe("OK");
    expect(seen).toMatchObject({ clean: 1, extract: 1, verify: 1 });
    expect(result.calls.calls).toBe(3);
    // Our keys' dueResolved agree with the pipeline's own date resolution.
    expect(result.score?.tasks).toEqual({ expected: 5, foundText: 5, foundFull: 5, produced: 5, truePositive: 5 });
    expect(result.score?.mustAppear.found).toBe(7);
    // Every item is supported, so the judge had nothing to do and was not called.
    expect(run.judge.status).toBe("not-needed");
    expect(run.used).toBe(3);
  });

  it("marks a swallowed CLEAN outage INFRA_ERROR, then retries the case once", async () => {
    // The first CLEAN request fails all three withRetry attempts; the
    // pipeline swallows that and carries on, so only the meter knows.
    const { send } = fakeGemini((step, n) => (step === "clean" && n <= 3 ? unavailable() : null));
    const run = await runEval({ ...base, cases: [projectCase()], send });

    const result = run.cases[0];
    expect(result.attempts).toBe(2);
    expect(result.status).toBe("OK");
    expect(result.calls).toMatchObject({ http503: 3, retries: 2, gaveUp: 1 });
    // 3 failed CLEAN attempts + EXTRACT + VERIFY, then a clean second run of 3.
    expect(run.used).toBe(8);
  });

  it("keeps an outage out of the accuracy numbers when the retry fails too", async () => {
    const { send } = fakeGemini((step) => (step === "extract" ? unavailable() : null));
    const run = await runEval({ ...base, judge: false, cases: [projectCase()], send });
    expect(run.cases[0].status).toBe("INFRA_ERROR");
    expect(run.cases[0].score).toBeUndefined();
  });

  it("stops before a case the budget cannot cover (BUDGET_STOP, nothing sent)", async () => {
    const { send } = fakeGemini();
    const run = await runEval({ ...base, cap: 3, cases: [projectCase()], send });
    // 3 calls needed + 1 judge reserve > 3.
    expect(run.cases[0].status).toBe("BUDGET_STOP");
    expect(send).not.toHaveBeenCalled();
  });

  it("calls a mid-case cap refusal BUDGET_STOP even though the pipeline swallowed it", async () => {
    // Estimate 3 fits a cap of 4, but two CLEAN retries use the slack and
    // VERIFY (whose failure the pipeline swallows) is refused.
    const { send } = fakeGemini((step, n) => (step === "clean" && n <= 2 ? unavailable() : null));
    const run = await runEval({ ...base, judge: false, cap: 4, cases: [projectCase()], send });
    expect(run.cases[0].status).toBe("BUDGET_STOP");
    expect(run.used).toBe(4);
  });

  it("scores audio cases with zero Gemini calls", async () => {
    const send = vi.fn();
    const audioCase: LoadedCase = {
      entry: { id: "ami-x", type: "ami", meeting: "X", priority: 1 },
      audioPath: "unused.wav",
      durationMs: 4000,
      reference: {
        me: "A",
        words: [
          { speaker: "A", text: "hello there", startMs: 0, endMs: 1000 },
          { speaker: "B", text: "hi how are you", startMs: 2000, endMs: 3500 },
        ],
      },
    };
    const run = await runEval({
      ...base,
      cases: [audioCase],
      send,
      transcribe: async () => [
        { text: "hello there", startMs: 0, endMs: 1000, channel: "mic" },
        { text: "hi how are you", startMs: 2000, endMs: 3500, channel: "remote" },
      ],
    });
    const audio = run.cases[0].audio!;
    expect(run.cases[0].status).toBe("OK");
    expect(audio.wer?.wer).toBe(0);
    expect(audio.der2?.der).toBe(0);
    expect(audio.me?.recall).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("report", () => {
  it("pools metrics over scored cases and lists outages apart", async () => {
    const { aggregate, renderMarkdown } = await import("../src/report");
    const ok = await runEval({ ...base, judge: false, cases: [projectCase()], send: fakeGemini().send });
    const down = await runEval({
      ...base,
      judge: false,
      cases: [{ ...projectCase(), entry: { ...projectCase().entry, id: "down" } }],
      send: fakeGemini((step) => (step === "extract" ? unavailable() : null)).send,
    });
    const run = { ...ok, cases: [...ok.cases, ...down.cases] };
    const pricing = { asOf: "x", currency: "USD", models: { "gemini-flash-latest": { inputPerMTok: 1, outputPerMTok: 1 }, "gemini-flash-lite-latest": { inputPerMTok: 1, outputPerMTok: 1 } } };
    const metrics = aggregate(run, pricing);

    expect(metrics.cases).toMatchObject({ ok: 1, infra: 1 });
    expect(metrics.infraShare).toBe(0.5);
    // The outage does not drag accuracy down.
    expect(metrics.headline.taskRecallFull).toBe(1);
    expect(metrics.headline.werMicro).toBeNull();
    expect(metrics.gemini.callsPerAudioMin).toBeGreaterThan(0);

    const md = renderMarkdown(run, metrics, null, "test");
    expect(md).toContain("**down**: INFRA_ERROR");
    expect(md).toContain("| Task recall (text + owner + date) | 100.0% |");
  });
});

describe("helpers", () => {
  it("estimates CLEAN + EXTRACT + VERIFY for a short case", () => {
    expect(estimateSummaryCalls(toPipelineSegments(project.segments))).toBe(3);
  });

  it("treats credentials and the ai-service being down as infrastructure", () => {
    const none = { calls: 0, retries: 0, http503: 0, http429: 0, network: 0, gaveUp: 0, refused: 0, ms: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
    expect(classifyAttempt(none, new Error("The AI service rejected our credentials. Check GEMINI_API_KEY.")).status).toBe("INFRA_ERROR");
    expect(classifyAttempt(none, new Error("parse failure")).status).toBe("PIPELINE_ERROR");
    expect(classifyAttempt(none, undefined).status).toBe("OK");
  });
});
