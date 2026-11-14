import { env } from "../../backend/src/lib/env";
import { getClient, parseJsonResponse, withRetry } from "../../backend/src/lib/gemini";
import { chunkByTokenBudget, runSummaryPipeline, type PipelineSegment } from "../../backend/src/services/summary.service";
import { transcribeAudioDetailed } from "../../backend/src/services/speech.service";
import type { ModeSetting, SummaryV2 } from "../../backend/src/types/summary";
import {
  channelTurns,
  computeWer,
  diarizationErrorRate,
  meAttribution,
  meVsOthers,
  speakerTurns,
  wordsToTurns,
  type DerResult,
  type HypSegment,
  type MeResult,
  type WerResult,
} from "./audio";
import { diarize } from "./diarize";
import { flattenSummary } from "./items";
import {
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  buildJudgeRequest,
  isEmptyRequest,
  judgePrompt,
  parseJudgeResponse,
  type JudgeCaseRequest,
} from "./judge";
import { GeminiMeter, type CaseCalls } from "./meter";
import { scoreSummary, type JudgeVerdict, type SummaryScore } from "./score";
import type { CaseStatus, LoadedCase, ProducedItem } from "./types";

/**
 * Runs the evaluation. Pipeline code is reached only through exported
 * functions (runSummaryPipeline, transcribeAudioDetailed,
 * diarizeSegments); Gemini only through the backend's shared client,
 * which the meter wraps for counting and the hard call cap.
 */

/** Mirrors the pipeline's defaults (summary.service.ts) for the call estimate. */
const CLEAN_BATCH = 150;
const TOKEN_BUDGET = 12_000;

const MODES: Record<string, ModeSetting> = {
  project: "PROJECT",
  lecture: "LECTURE",
  interview: "INTERVIEW",
  "one-on-one": "ONE_ON_ONE",
  general: "GENERAL",
};

export const toPipelineSegments = (segments: { speaker: string; text: string; startMs: number; endMs: number }[]): PipelineSegment[] =>
  segments.map((segment, idx) => ({ idx, ...segment }));

/**
 * Upper bound on Gemini requests for one summary with a fixed mode:
 * CLEAN batches + EXTRACT chunks + REDUCE (if more than one chunk) + VERIFY.
 * Retries come on top; the meter counts them against the cap.
 */
export const estimateSummaryCalls = (segments: PipelineSegment[]): number => {
  const chunks = chunkByTokenBudget(segments, TOKEN_BUDGET).length;
  return Math.ceil(segments.length / CLEAN_BATCH) + chunks + (chunks > 1 ? 1 : 0) + 1;
};

export interface AudioMetrics {
  wer?: WerResult;
  der2?: DerResult;
  derN?: DerResult;
  me?: MeResult;
  segments: number;
}

export interface CaseResult {
  id: string;
  type: string;
  status: CaseStatus;
  reason?: string;
  durationMs: number;
  /** Wall-clock time of the case, including retry waits. */
  wallMs: number;
  estimate: number;
  attempts: number;
  calls: CaseCalls;
  mode?: string;
  tldr?: string;
  produced?: ProducedItem[];
  score?: SummaryScore;
  audio?: AudioMetrics;
  /** Kept for the raw run folder and --replay; never printed for own cases. */
  summary?: SummaryV2;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  cap: number;
  used: number;
  judge: {
    status: "ran" | "skipped" | "failed" | "not-needed";
    reason?: string;
    calls: CaseCalls;
    /** Per case, for --replay. */
    verdicts?: Record<string, JudgeVerdict>;
  };
  cases: CaseResult[];
  models: { main: string; clean: string };
}

export interface RunOptions {
  cases: LoadedCase[];
  /** Hard cap on Gemini requests for the whole run (every attempt counts). */
  cap: number;
  judge: boolean;
  /** Also run diarization (DER-N) on audio cases; costs Gemini calls with the current diarizer. */
  diarize: boolean;
  /** Seconds to wait before re-running a case that hit an outage. */
  retryWaitMs: number;
  /** Replaces the real Gemini request (tests). */
  send?: (params: Record<string, unknown>) => Promise<unknown>;
  /** Replaces transcription (tests). */
  transcribe?: (audioPath: string) => Promise<HypSegment[]>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const emptyCalls = (): CaseCalls => ({
  calls: 0,
  retries: 0,
  http503: 0,
  http429: 0,
  network: 0,
  gaveUp: 0,
  refused: 0,
  ms: 0,
  inputTokens: 0,
  outputTokens: 0,
  byModel: {},
});

const addCalls = (a: CaseCalls, b: CaseCalls): CaseCalls => {
  const byModel = { ...a.byModel };
  for (const [model, usage] of Object.entries(b.byModel)) {
    const prev = byModel[model] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    byModel[model] = {
      calls: prev.calls + usage.calls,
      inputTokens: prev.inputTokens + usage.inputTokens,
      outputTokens: prev.outputTokens + usage.outputTokens,
    };
  }
  return {
    calls: a.calls + b.calls,
    retries: a.retries + b.retries,
    http503: a.http503 + b.http503,
    http429: a.http429 + b.http429,
    network: a.network + b.network,
    gaveUp: a.gaveUp + b.gaveUp,
    refused: a.refused + b.refused,
    ms: a.ms + b.ms,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    byModel,
  };
};

/**
 * The service, not the pipeline, failed when a request was still failing
 * transiently after its retries (even if the pipeline swallowed it), or
 * when the run's call cap refused a request mid-case.
 */
export const classifyAttempt = (calls: CaseCalls, error: unknown): { status: CaseStatus; reason?: string } => {
  if (calls.refused > 0) return { status: "BUDGET_STOP", reason: "the run's Gemini call cap was reached mid-case" };
  if (calls.gaveUp > 0) {
    return {
      status: "INFRA_ERROR",
      reason: `${calls.gaveUp} Gemini request(s) still failing after retries (503: ${calls.http503}, 429: ${calls.http429}, network: ${calls.network})`,
    };
  }
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Credentials and configuration are infrastructure too.
    if (/credentials|GEMINI_API_KEY|transcription service|ai-service|ECONNREFUSED/i.test(message)) {
      return { status: "INFRA_ERROR", reason: message };
    }
    return { status: "PIPELINE_ERROR", reason: message };
  }
  return { status: "OK" };
};

export async function runEval(options: RunOptions): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const meter = new GeminiMeter(options.cap);
  const uninstall = meter.install(
    getClient().models as unknown as { generateContent: (p: Record<string, unknown>) => Promise<unknown> },
    options.send
  );
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  const judgeReserve = options.judge ? 1 : 0;

  try {
    const ordered = [...options.cases].sort((a, b) => (a.entry.priority ?? 0) - (b.entry.priority ?? 0));

    for (const loaded of ordered) {
      const { entry } = loaded;
      const started = Date.now();

      if (loaded.segments && loaded.key) {
        results.push(await runTranscriptCase(loaded, meter, judgeReserve, options, sleep, log));
      } else if (loaded.audioPath) {
        results.push(await runAudioCase(loaded, meter, options, log));
      } else {
        results.push({
          id: entry.id,
          type: entry.type,
          status: "SKIPPED",
          reason: "nothing to run",
          durationMs: 0,
          wallMs: 0,
          estimate: 0,
          attempts: 0,
          calls: emptyCalls(),
        });
      }
      const last = results[results.length - 1];
      last.wallMs = Date.now() - started;
      log(`${entry.id}: ${last.status}${last.reason ? ` (${last.reason})` : ""}, ${last.calls.calls} call(s), ${(last.wallMs / 1000).toFixed(1)} s`);
    }

    const judge = await runJudge(results, options, meter, log);
    for (const result of results) {
      const loaded = options.cases.find((c) => c.entry.id === result.id);
      if (!loaded?.key || !loaded.segments) continue;
      // A pipeline bug scores as "nothing found"; an outage is not scored.
      if (result.status !== "OK" && result.status !== "PIPELINE_ERROR") continue;
      result.score = scoreSummary({
        key: loaded.key,
        segments: loaded.segments,
        produced: result.produced ?? [],
        tldr: result.tldr ?? "",
        verdict: judge.verdicts?.get(result.id),
      });
    }

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      cap: options.cap,
      used: meter.used,
      judge: {
        status: judge.status,
        reason: judge.reason,
        calls: meter.forCase("judge"),
        verdicts: judge.verdicts ? Object.fromEntries(judge.verdicts) : undefined,
      },
      cases: results,
      models: { main: env.geminiModel, clean: env.geminiCleanModel },
    };
  } finally {
    uninstall();
  }
}

async function runTranscriptCase(
  loaded: LoadedCase,
  meter: GeminiMeter,
  judgeReserve: number,
  options: RunOptions,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void
): Promise<CaseResult> {
  const { entry, key } = loaded;
  const segments = toPipelineSegments(loaded.segments!);
  const estimate = estimateSummaryCalls(segments);
  const modeSetting = MODES[key!.mode] ?? "GENERAL";
  const base = {
    id: entry.id,
    type: entry.type,
    durationMs: loaded.durationMs,
    wallMs: 0,
    estimate,
    mode: modeSetting,
  };

  let calls = emptyCalls();
  let attempts = 0;
  let outcome: { status: CaseStatus; reason?: string } = { status: "SKIPPED" };
  let summary: SummaryV2 | undefined;

  // At most two attempts; the second only after an outage and only when
  // the budget still covers a whole attempt plus the judge.
  while (attempts < 2) {
    if (estimate > meter.remaining - judgeReserve) {
      outcome =
        attempts === 0
          ? { status: "BUDGET_STOP", reason: `needs up to ${estimate} call(s), ${meter.remaining} left (judge reserve ${judgeReserve})` }
          : outcome;
      break;
    }

    if (attempts === 1) {
      log(`${entry.id}: outage, retrying once in ${Math.round(options.retryWaitMs / 1000)} s`);
      await sleep(options.retryWaitMs);
    }

    attempts++;
    const tag = `${entry.id}#${attempts}`;
    meter.currentCase = tag;
    let error: unknown;
    summary = undefined;

    try {
      const result = await runSummaryPipeline(segments, {
        modeSetting,
        meetingStart: new Date(entry.meetingStart!),
        timezone: entry.timezone,
      });
      summary = result.summary;
    } catch (caught) {
      error = caught;
    }

    const attemptCalls = meter.forCase(tag);
    calls = addCalls(calls, attemptCalls);
    outcome = classifyAttempt(attemptCalls, error);
    if (outcome.status !== "INFRA_ERROR") break;
  }

  meter.currentCase = "-";
  return {
    ...base,
    ...outcome,
    attempts,
    calls,
    summary: outcome.status === "OK" ? summary : undefined,
    tldr: outcome.status === "OK" ? summary?.tldr : undefined,
    produced: outcome.status === "OK" && summary ? flattenSummary(summary) : undefined,
  };
}

async function runAudioCase(
  loaded: LoadedCase,
  meter: GeminiMeter,
  options: RunOptions,
  log: (line: string) => void
): Promise<CaseResult> {
  const { entry } = loaded;
  const base = { id: entry.id, type: entry.type, durationMs: loaded.durationMs, wallMs: 0, estimate: 0, attempts: 1 };
  meter.currentCase = entry.id;

  try {
    const hyp: HypSegment[] = options.transcribe
      ? await options.transcribe(loaded.audioPath!)
      : (await transcribeAudioDetailed(loaded.audioPath!, 0, { channelLayout: "stereo-mic-left" })).segments;

    const audio: AudioMetrics = { segments: hyp.length };
    const reference = loaded.reference;
    if (reference) {
      const refTurns = wordsToTurns(reference.words);
      audio.wer = computeWer(reference, hyp);
      audio.der2 = diarizationErrorRate(meVsOthers(refTurns, reference.me), channelTurns(hyp));
      audio.me = meAttribution(reference, hyp);

      if (options.diarize) {
        log(`${entry.id}: diarizing ${hyp.length} segments`);
        audio.derN = diarizationErrorRate(refTurns, speakerTurns(await diarize(hyp)));
      }
    }

    const calls = meter.forCase(entry.id);
    const outcome = classifyAttempt(calls, undefined);
    return { ...base, ...outcome, calls, audio };
  } catch (error) {
    const calls = meter.forCase(entry.id);
    const outcome = classifyAttempt(calls, error);
    // A transcription failure is the service's, not the model's accuracy.
    return {
      ...base,
      ...(outcome.status === "PIPELINE_ERROR" ? { ...outcome, status: "INFRA_ERROR" as const } : outcome),
      calls,
    };
  } finally {
    meter.currentCase = "-";
  }
}

async function runJudge(
  results: CaseResult[],
  options: RunOptions,
  meter: GeminiMeter,
  log: (line: string) => void
): Promise<{ status: RunResult["judge"]["status"]; reason?: string; verdicts?: Map<string, JudgeVerdict> }> {
  const requests: JudgeCaseRequest[] = results.flatMap((result) => {
    const loaded = options.cases.find((c) => c.entry.id === result.id);
    if (result.status !== "OK" || !result.produced || !loaded?.key || !loaded.segments) return [];
    return [buildJudgeRequest(result.id, loaded.key, loaded.segments, result.produced)];
  });

  if (!options.judge) return { status: "skipped", reason: "--no-judge" };
  if (!requests.length || isEmptyRequest(requests)) {
    // Nothing to settle: every case gets an empty (but present) verdict.
    return { status: "not-needed", verdicts: new Map(requests.map((r) => [r.caseId, { matches: [], unsupported: [] }])) };
  }
  if (meter.remaining < 1) return { status: "skipped", reason: "no Gemini budget left" };

  meter.currentCase = "judge";
  try {
    const response = await withRetry(() =>
      getClient().models.generateContent({
        model: env.geminiCleanModel,
        contents: judgePrompt(requests),
        config: {
          systemInstruction: JUDGE_SYSTEM,
          responseMimeType: "application/json",
          responseSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
          temperature: 0,
        },
      })
    );
    const verdicts = parseJudgeResponse(parseJsonResponse(response.text ?? "", "judge verdict"), requests);
    log(`judge: ${[...verdicts.values()].reduce((n, v) => n + v.matches.length, 0)} rescued match(es), ${[...verdicts.values()].reduce((n, v) => n + v.unsupported.length, 0)} unsupported item(s)`);
    return { status: "ran", verdicts };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`judge failed: ${reason}`);
    return { status: "failed", reason };
  } finally {
    meter.currentCase = "-";
  }
}
