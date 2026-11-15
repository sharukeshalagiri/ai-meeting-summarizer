import { HEADLINE, type Comparison, type MetricName, type Metrics } from "./report";

/**
 * The regression gate. eval:check compares a report's headline metrics
 * with eval/baseline.json; eval:accept rewrites the baseline on purpose.
 */

export interface Baseline {
  /** "placeholder" until the first real run is accepted. */
  status: "placeholder" | "accepted";
  acceptedAt?: string;
  note?: string;
  /** The report the numbers came from. */
  report?: string;
  metrics: Partial<Record<MetricName, number | null>>;
  /** Allowed absolute drop per metric; missing entries use the defaults in report.ts. */
  tolerances: Partial<Record<MetricName, number>>;
}

/** Above this share of INFRA_ERROR / BUDGET_STOP cases a run proves nothing. */
export const INCONCLUSIVE_SHARE = 0.25;

export const EXIT = { ok: 0, regressed: 1, inconclusive: 2 } as const;

export const compare = (metrics: Metrics, baseline: Baseline): Comparison[] =>
  HEADLINE.map((spec) => {
    const current = metrics.headline[spec.name];
    const base = baseline.metrics[spec.name] ?? null;
    const tolerance = baseline.tolerances[spec.name] ?? spec.tolerance;

    if (current === null) return { name: spec.name, current, baseline: base, delta: null, tolerance, verdict: "not measured" };
    if (base === null) return { name: spec.name, current, baseline: base, delta: null, tolerance, verdict: "no baseline" };

    const delta = current - base;
    // Positive "worse" means the metric moved the wrong way.
    const worse = spec.better === "higher" ? -delta : delta;
    // A hair of float noise must not fail the gate.
    const verdict = worse > tolerance + 1e-9 ? "regressed" : worse < -1e-9 ? "improved" : "ok";
    return { name: spec.name, current, baseline: base, delta, tolerance, verdict };
  });

export const checkOutcome = (
  metrics: Metrics,
  comparisons: Comparison[]
): { exit: number; summary: string } => {
  if (metrics.infraShare > INCONCLUSIVE_SHARE) {
    return {
      exit: EXIT.inconclusive,
      summary:
        `INCONCLUSIVE: ${(metrics.infraShare * 100).toFixed(0)}% of cases failed for infrastructure reasons ` +
        `(INFRA_ERROR or BUDGET_STOP, limit ${INCONCLUSIVE_SHARE * 100}%). Re-run when the service is healthy.`,
    };
  }

  const regressed = comparisons.filter((c) => c.verdict === "regressed");
  if (regressed.length) {
    return {
      exit: EXIT.regressed,
      summary: `REGRESSED: ${regressed
        .map((c) => `${c.name} ${c.baseline!.toFixed(3)} -> ${c.current!.toFixed(3)} (tolerance ${c.tolerance})`)
        .join("; ")}`,
    };
  }

  const measured = comparisons.filter((c) => c.verdict === "ok" || c.verdict === "improved").length;
  return {
    exit: EXIT.ok,
    summary: measured
      ? `OK: ${measured} headline metric(s) within tolerance.`
      : "OK (nothing compared): the baseline has no numbers for these metrics yet. Run eval:accept after the first real run.",
  };
};

/** Baseline from a report's metrics; keeps existing tolerances. */
export const acceptBaseline = (metrics: Metrics, previous: Baseline, report: string, note: string, now = new Date()): Baseline => {
  const merged: Partial<Record<MetricName, number | null>> = { ...previous.metrics };
  for (const spec of HEADLINE) {
    const value = metrics.headline[spec.name];
    // A metric this run did not measure (e.g. no AMI data) keeps its old baseline.
    if (value !== null) merged[spec.name] = Number(value.toFixed(4));
  }
  const tolerances = { ...Object.fromEntries(HEADLINE.map((s) => [s.name, s.tolerance])), ...previous.tolerances };
  return { status: "accepted", acceptedAt: now.toISOString(), note, report, metrics: merged, tolerances };
};
