import type { Sourced, SummaryItem } from "../../types/summary";

/**
 * Authoring helpers for the hand-written demo summaries. Confidence
 * mirrors what VERIFY writes: high for items quoted almost verbatim,
 * lower (and flagged for review) for inferences, so the demo also shows
 * the "needs review" state.
 */

export const src = (...idx: number[]): Sourced<number> => ({
  evidence: idx,
  confidence: 0.92,
  needsReview: false,
});

/** An inferred item: below the review threshold (0.6), so it is flagged. */
export const inferred = (...idx: number[]): Sourced<number> => ({
  evidence: idx,
  confidence: 0.55,
  needsReview: true,
});

export const item = (text: string, ...idx: number[]): SummaryItem<number> => ({
  text,
  ...src(...idx),
});
