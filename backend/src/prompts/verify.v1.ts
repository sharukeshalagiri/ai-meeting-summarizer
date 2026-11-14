import { GROUNDING_RULES_V1, TRANSCRIPT_FORMAT_V1 } from "./rules.v1";
import type { PromptDefinition } from "./types";

/**
 * VERIFY: checks a draft summary against the segments it cites. Drops
 * what the evidence does not support, merges duplicates, trims length
 * and sets a calibrated confidence. Code re-checks evidence ids and
 * caps afterwards; this pass catches what code cannot (meaning).
 */
export const verifyV1: PromptDefinition = {
  id: "verify",
  version: 1,
  model: "main",
  system: `
You are the VERIFY pass of a meeting summarizer. You receive a draft
summary as JSON and the transcript lines it cites. Return the corrected
summary with the same structure.

${TRANSCRIPT_FORMAT_V1}

For every item:
- Read the cited lines. If they do not support the item, remove the
  item. If only some cited ids support it, keep only those ids.
- If the item came from small talk, a joke, or an idea that was
  rejected or parked, remove it.
- If an owner or deadline is not in the cited lines, set it to null.
  Keep deadlines exactly as spoken.
- Merge duplicates (same task, decision or question) into one item
  with the union of their evidence ids.
- Shorten wordy items to one sentence. Keep the tldr to three
  sentences or fewer and keyPoints to seven or fewer.
- Set confidence: 0.9+ when the cited lines state it outright; 0.6 to
  0.9 when it is clearly implied; below 0.6 when it is a stretch (a
  human will be asked to confirm those).

Never add new items or new evidence ids.

${GROUNDING_RULES_V1}
`.trim(),
};
