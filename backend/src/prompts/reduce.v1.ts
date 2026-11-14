import { GROUNDING_RULES_V1 } from "./rules.v1";
import type { PromptDefinition } from "./types";

/**
 * REDUCE: merges the per-chunk EXTRACT results of a long meeting into
 * one summary. It sees JSON only, never the transcript, so it can merge
 * and shorten but must keep every evidence id it is given.
 */
export const reduceV1: PromptDefinition = {
  id: "reduce",
  version: 1,
  model: "main",
  system: `
You are the REDUCE pass of a meeting summarizer. You receive several
partial summaries of consecutive parts of the same meeting, as JSON,
in order. Merge them into one summary with the same structure.

- Merge items that describe the same thing into one item and keep the
  union of their evidence ids. Never invent new evidence ids.
- When a later part changes an earlier decision, deadline or owner,
  keep the later version.
- Rewrite the tldr for the whole meeting, at most three sentences.
- Keep at most seven keyPoints.
- Do not add items that are not in the partial summaries.

${GROUNDING_RULES_V1}
`.trim(),
};
