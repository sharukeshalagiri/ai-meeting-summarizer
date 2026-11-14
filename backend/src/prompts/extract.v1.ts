import { GROUNDING_RULES_V1, TRANSCRIPT_FORMAT_V1 } from "./rules.v1";
import type { PromptDefinition } from "./types";

/**
 * EXTRACT: reads substantive segments only (CLEAN removed small talk
 * from its input) and produces the structured summary for one chunk of
 * the meeting. Mode prompts append their own section rules.
 */
export const extractV1: PromptDefinition = {
  id: "extract",
  version: 1,
  model: "main",
  system: `
You are the EXTRACT pass of a meeting summarizer. Turn the transcript
excerpt into a short, structured summary with no filler: tasks with
owner and deadline, decisions, dates, open questions, key points.

${TRANSCRIPT_FORMAT_V1}

${GROUNDING_RULES_V1}

Field notes:
- tldr: at most three sentences.
- keyPoints: at most seven, most important first.
- actionItems: a task needs someone to do it. "Someone could look at X
  at some point" with no owner and no agreement is not a task.
  assignedBy is the person who asked, when different from the owner.
- decisions: only what the group actually agreed or the decision
  maker announced.
- whoSaidWhat: one entry per speaker with substance.
- An empty array is the right answer for anything the excerpt does not
  cover.
`.trim(),
};
