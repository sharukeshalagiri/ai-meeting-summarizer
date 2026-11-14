import { costOf, type Pricing } from "./meter";
import type { CaseResult, RunResult } from "./run";

/**
 * Turns a run into metrics (pooled over cases) and a Markdown report.
 * Only OK cases (and PIPELINE_ERROR cases, scored as "nothing found")
 * feed accuracy; INFRA_ERROR and BUDGET_STOP cases are listed apart so
 * an outage never reads as low accuracy.
 */

export type MetricName =
  | "taskRecallFull"
  | "taskPrecision"
  | "hallucinationRate"
  | "trapHitRate"
  | "examRecall"
  | "dateAccuracy"
  | "werMicro"
  | "der2"
  | "meRecall";

export interface MetricSpec {
  name: MetricName;
  label: string;
  better: "higher" | "lower";
  /** Default allowed drop before eval:check fails (absolute). */
  tolerance: number;
}

export const HEADLINE: MetricSpec[] = [
  { name: "taskRecallFull", label: "Task recall (text + owner + date)", better: "higher", tolerance: 0.1 },
  { name: "taskPrecision", label: "Task precision", better: "higher", tolerance: 0.1 },
  { name: "hallucinationRate", label: "Hallucination rate", better: "lower", tolerance: 0.05 },
  { name: "trapHitRate", label: "must-NOT-appear hit rate", better: "lower", tolerance: 0.05 },
  { name: "examRecall", label: "Exam-question recall", better: "higher", tolerance: 0.25 },
  { name: "dateAccuracy", label: "Date accuracy", better: "higher", tolerance: 0.1 },
  { name: "werMicro", label: "WER (AMI, pooled)", better: "lower", tolerance: 0.03 },
  { name: "der2", label: "DER me/others (AMI)", better: "lower", tolerance: 0.05 },
  { name: "meRecall", label: "My lines labelled as me", better: "higher", tolerance: 0.05 },
];

export interface Metrics {
  cases: Record<"total" | "ok" | "infra" | "budget" | "pipeline" | "skipped", number>;
  /** Share of attempted cases that the service, not the pipeline, failed. */
  infraShare: number;
  headline: Record<MetricName, number | null>;
  secondary: {
    mustAppearRecall: number | null;
    taskRecallText: number | null;
    citationAccuracy: number | null;
    tldrWordsMean: number | null;
    tldrWordsMax: number | null;
    tldrOver60: number;
    derN: number | null;
    mePrecision: number | null;
    suspects: number;
    judgedCases: number;
  };
  gemini: {
    used: number;
    cap: number;
    http503: number;
    http429: number;
    retries: number;
    judge: string;
    callsPerAudioMin: number | null;
    costUsd: number | null;
    costPerAudioMin: number | null;
    latencySecPerAudioMin: number | null;
  };
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const sum = <T>(items: T[], f: (item: T) => number) => items.reduce((n, item) => n + f(item), 0);

export const aggregate = (run: RunResult, pricing: Pricing): Metrics => {
  const all = run.cases;
  const scored = all.filter((c) => c.score);
  const audio = all.filter((c) => c.status === "OK" && c.audio);
  const summaryOk = all.filter((c) => c.status === "OK" && c.type !== "ami" && c.score);
  const byStatus = (status: string) => all.filter((c) => c.status === status).length;
  const attempted = all.filter((c) => c.status !== "SKIPPED").length;

  const s = (f: (c: CaseResult) => number) => sum(scored, f);
  const tldrs = summaryOk.map((c) => c.score!.tldr.words);
  const minutes = sum(summaryOk, (c) => c.durationMs) / 60000;
  const caseCalls = summaryOk.map((c) => c.calls);
  const cost = [...caseCalls, run.judge.calls].reduce<number | null>((total, calls) => {
    const value = costOf(calls, pricing);
    return total === null || value === null ? null : total + value;
  }, 0);

  const wers = audio.filter((c) => c.audio!.wer);
  const der2 = audio.filter((c) => c.audio!.der2);
  const derN = audio.filter((c) => c.audio!.derN);
  const me = audio.filter((c) => c.audio!.me && c.audio!.me.meWords > 0);

  return {
    cases: {
      total: all.length,
      ok: byStatus("OK"),
      infra: byStatus("INFRA_ERROR"),
      budget: byStatus("BUDGET_STOP"),
      pipeline: byStatus("PIPELINE_ERROR"),
      skipped: byStatus("SKIPPED"),
    },
    infraShare: attempted ? (byStatus("INFRA_ERROR") + byStatus("BUDGET_STOP")) / attempted : 0,
    headline: {
      taskRecallFull: ratio(s((c) => c.score!.tasks.foundFull), s((c) => c.score!.tasks.expected)),
      taskPrecision: ratio(s((c) => c.score!.tasks.truePositive), s((c) => c.score!.tasks.produced)),
      hallucinationRate: ratio(
        s((c) => c.score!.hallucination.trapItems + c.score!.hallucination.judgedUnsupported),
        s((c) => c.score!.hallucination.produced)
      ),
      trapHitRate: ratio(s((c) => c.score!.traps.hit.length), s((c) => c.score!.traps.total)),
      examRecall: ratio(s((c) => c.score!.exam.found), s((c) => c.score!.exam.total)),
      dateAccuracy: ratio(s((c) => c.score!.dates.correct), s((c) => c.score!.dates.total)),
      werMicro: ratio(sum(wers, (c) => c.audio!.wer!.errors), sum(wers, (c) => c.audio!.wer!.refWords)),
      der2: ratio(sum(der2, (c) => c.audio!.der2!.der * c.audio!.der2!.scoredMs), sum(der2, (c) => c.audio!.der2!.scoredMs)),
      meRecall: ratio(sum(me, (c) => c.audio!.me!.recall * c.audio!.me!.meWords), sum(me, (c) => c.audio!.me!.meWords)),
    },
    secondary: {
      mustAppearRecall: ratio(s((c) => c.score!.mustAppear.found), s((c) => c.score!.mustAppear.total)),
      taskRecallText: ratio(s((c) => c.score!.tasks.foundText), s((c) => c.score!.tasks.expected)),
      citationAccuracy: ratio(s((c) => c.score!.citations.correct), s((c) => c.score!.citations.checked)),
      tldrWordsMean: tldrs.length ? sum(tldrs, (n) => n) / tldrs.length : null,
      tldrWordsMax: tldrs.length ? Math.max(...tldrs) : null,
      tldrOver60: tldrs.filter((n) => n > 60).length,
      derN: ratio(sum(derN, (c) => c.audio!.derN!.der * c.audio!.derN!.scoredMs), sum(derN, (c) => c.audio!.derN!.scoredMs)),
      mePrecision: me.length ? sum(me, (c) => c.audio!.me!.precision) / me.length : null,
      suspects: s((c) => c.score!.hallucination.suspects),
      judgedCases: scored.filter((c) => c.score!.judged).length,
    },
    gemini: {
      used: run.used,
      cap: run.cap,
      http503: sum(all, (c) => c.calls.http503) + run.judge.calls.http503,
      http429: sum(all, (c) => c.calls.http429) + run.judge.calls.http429,
      retries: sum(all, (c) => c.calls.retries) + run.judge.calls.retries,
      judge: run.judge.status,
      callsPerAudioMin: minutes ? (sum(caseCalls, (c) => c.calls) + run.judge.calls.calls) / minutes : null,
      costUsd: cost,
      costPerAudioMin: minutes && cost !== null ? cost / minutes : null,
      latencySecPerAudioMin: minutes ? sum(summaryOk, (c) => c.wallMs) / 1000 / minutes : null,
    },
  };
};

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null, digits = 2) => (value === null ? "n/a" : value.toFixed(digits));

export interface Comparison {
  name: MetricName;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  tolerance: number;
  verdict: "ok" | "regressed" | "improved" | "not measured" | "no baseline";
}

export const renderMarkdown = (run: RunResult, metrics: Metrics, comparisons: Comparison[] | null, title: string): string => {
  const lines: string[] = [];
  const isOwn = (c: CaseResult) => c.type === "own";

  lines.push(`# Evaluation report ${title}`, "");
  lines.push(
    `Run ${run.startedAt} → ${run.finishedAt}. Models: ${run.models.main} (summary), ${run.models.clean} (CLEAN, judge). ` +
      `Gemini requests: **${metrics.gemini.used} / ${metrics.gemini.cap}** (every retry counts), 503s: ${metrics.gemini.http503}, 429s: ${metrics.gemini.http429}, retries: ${metrics.gemini.retries}. Judge: ${metrics.gemini.judge}.`,
    ""
  );
  lines.push(
    `Cases: ${metrics.cases.ok} OK, ${metrics.cases.infra} INFRA_ERROR, ${metrics.cases.budget} BUDGET_STOP, ` +
      `${metrics.cases.pipeline} PIPELINE_ERROR, ${metrics.cases.skipped} skipped (of ${metrics.cases.total}). ` +
      `INFRA_ERROR and BUDGET_STOP cases are excluded from every accuracy number below.`,
    ""
  );

  lines.push("## Headline metrics", "", "| Metric | Value | Baseline | Δ | Tolerance | Verdict |", "| --- | --- | --- | --- | --- | --- |");
  for (const spec of HEADLINE) {
    const value = metrics.headline[spec.name];
    const cmp = comparisons?.find((c) => c.name === spec.name);
    // Every headline metric is a rate.
    const fmt = pct;
    lines.push(
      `| ${spec.label} | ${fmt(value)} | ${cmp ? fmt(cmp.baseline) : "n/a"} | ${cmp?.delta == null ? "n/a" : `${cmp.delta >= 0 ? "+" : ""}${(cmp.delta * 100).toFixed(1)} pt`} | ${(spec.tolerance * 100).toFixed(0)} pt | ${cmp?.verdict ?? "no baseline"} |`
    );
  }
  lines.push("");

  const sec = metrics.secondary;
  const g = metrics.gemini;
  lines.push("## Secondary", "");
  lines.push(`- must-appear recall (all kinds): ${pct(sec.mustAppearRecall)}; task recall on text only: ${pct(sec.taskRecallText)}`);
  lines.push(`- correct citations among found items: ${pct(sec.citationAccuracy)}`);
  lines.push(`- TL;DR words: mean ${num(sec.tldrWordsMean, 1)}, max ${num(sec.tldrWordsMax, 0)}, over 60 words: ${sec.tldrOver60}`);
  lines.push(`- low-support items sent to the judge: ${sec.suspects}; cases with a judge verdict: ${sec.judgedCases}`);
  lines.push(`- DER all speakers (--diarize): ${pct(sec.derN)}; "me" precision: ${pct(sec.mePrecision)}`);
  lines.push(
    `- per audio minute (summary cases): ${num(g.callsPerAudioMin)} calls, ${g.costPerAudioMin === null ? "n/a" : `$${g.costPerAudioMin.toFixed(5)}`}, ${num(g.latencySecPerAudioMin, 1)} s; run cost ${g.costUsd === null ? "n/a" : `$${g.costUsd.toFixed(4)}`} (eval/pricing.json)`
  );
  lines.push("");

  lines.push("## Cases", "", "| Case | Status | Calls (503/retries) | Must-appear | Tasks found/exp (full) | Tasks TP/produced | Traps hit | Dates | Exam | TL;DR words | WER | DER-2 | Me |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of run.cases) {
    const sc = c.score;
    const a = c.audio;
    lines.push(
      `| ${c.id} | ${c.status} | ${c.calls.calls} (${c.calls.http503}/${c.calls.retries}) | ${sc ? `${sc.mustAppear.found}/${sc.mustAppear.total}` : "-"} | ${sc ? `${sc.tasks.foundText}/${sc.tasks.expected} (${sc.tasks.foundFull})` : "-"} | ${sc ? `${sc.tasks.truePositive}/${sc.tasks.produced}` : "-"} | ${sc ? `${sc.traps.hit.length}/${sc.traps.total}` : "-"} | ${sc ? `${sc.dates.correct}/${sc.dates.total}` : "-"} | ${sc && sc.exam.total ? `${sc.exam.found}/${sc.exam.total}` : "-"} | ${sc ? sc.tldr.words : "-"} | ${a?.wer ? pct(a.wer.wer) : "-"} | ${a?.der2 ? pct(a.der2.der) : "-"} | ${a?.me ? pct(a.me.recall) : "-"} |`
    );
  }
  lines.push("");

  const excluded = run.cases.filter((c) => c.status !== "OK");
  if (excluded.length) {
    lines.push("## Not scored as accuracy", "");
    for (const c of excluded) lines.push(`- **${c.id}**: ${c.status}${c.reason ? `: ${c.reason}` : ""}`);
    lines.push("");
  }

  lines.push("## Details (synthetic cases only)", "");
  for (const c of run.cases) {
    if (!c.score || isOwn(c)) continue;
    const misses = c.score.mustAppear.items.filter((i) => !i.found || i.ownerOk === false || i.dueOk === false || i.citationOk === false);
    const counts = c.score.counts.map((v) => `${v.kind}: expected ${v.expected}, got ${v.actual}`);
    if (!misses.length && !c.score.traps.hit.length && !counts.length) continue;
    lines.push(`### ${c.id}`);
    for (const m of misses) {
      const why = !m.found ? "not found" : [m.ownerOk === false && "wrong owner", m.dueOk === false && "wrong deadline", m.citationOk === false && "wrong citation"].filter(Boolean).join(", ");
      lines.push(`- ${m.id} (${m.kind}): ${why}${m.ref ? ` [${m.ref}]` : ""}`);
    }
    for (const id of c.score.traps.hit) lines.push(`- must-NOT-appear hit: ${id}`);
    for (const line of counts) lines.push(`- count mismatch: ${line}`);
    lines.push("");
  }

  return lines.join("\n");
};
