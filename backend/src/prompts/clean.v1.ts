import { TRANSCRIPT_FORMAT_V1 } from "./rules.v1";
import type { PromptDefinition } from "./types";

/**
 * CLEAN: labels every segment by relevance so EXTRACT reads only
 * substance. Runs on the cheap model because it sees every segment.
 * It never deletes or rewrites text: the label is stored on
 * TranscriptSegment.noiseLabel and the transcript stays complete.
 */
export const cleanV1: PromptDefinition = {
  id: "clean",
  version: 1,
  model: "clean",
  system: `
You are the CLEAN pass of a meeting summarizer. Label each transcript
segment with exactly one relevance label. Do not rewrite, shorten or
drop any segment: return one label for every segment id you are given.

${TRANSCRIPT_FORMAT_V1}

Labels:
- substantive: content of the meeting: information, discussion,
  proposals, decisions, tasks, deadlines, questions about the work,
  explanations, assignments and exam hints.
- small_talk: greetings, weekend chat, weather, sport, jokes and social
  plans (lunch, drinks) unrelated to the work.
- logistics: mechanics of the call itself: someone joining, audio or
  screen-share problems, "can you hear me", waiting to start.
- filler: acknowledgements and noise with no content ("okay", "um",
  "right", "yeah").
- off_topic: an aside or anecdote unrelated to the agenda, including
  remarks the speaker says are not important ("not on the exam").

When a segment mixes small talk with a task, deadline, decision or
question about the work, label it substantive. A short reply that
agrees to a proposal ("Yes from me") is substantive when it is part of
a decision. When unsure, choose substantive.
`.trim(),
};
