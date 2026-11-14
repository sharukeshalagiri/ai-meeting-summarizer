import { Type } from "@google/genai";
import { list, sourced, textItem } from "../schemas.v1";
import type { ModePromptDefinition } from "../types";

const str = { type: Type.STRING };

/** INTERVIEW: what was asked, how it was answered, what comes next. */
export const interviewV1: ModePromptDefinition = {
  id: "mode.interview",
  version: 1,
  sectionKey: "interview",
  system: `
This session is an INTERVIEW. Fill sections.interview:
- qa: each substantive question asked, with a one-sentence summary of
  the answer. Cite both the question and the answer segments.
- followUps: questions or topics either side said to follow up on.
- strengths: what the answers showed well, each backed by evidence.
- concerns: gaps or weak answers, each backed by evidence. Stay
  factual; no judgement the transcript does not support.
- nextSteps: what happens after the interview (next round, take-home,
  decision date) as spoken.
- struggledWith: questions the person who recorded the session (the
  "mic" side, usually the candidate) answered weakly or could not
  answer, so they can prepare next time.
`.trim(),
  schema: {
    type: Type.OBJECT,
    properties: {
      qa: list(sourced({ question: str, answerSummary: str }), "Question and answer."),
      followUps: textItem("Follow-ups."),
      strengths: textItem("Strengths with evidence."),
      concerns: textItem("Concerns with evidence."),
      nextSteps: textItem("Next steps."),
      struggledWith: textItem("Questions answered weakly."),
    },
    required: [
      "qa",
      "followUps",
      "strengths",
      "concerns",
      "nextSteps",
      "struggledWith",
    ],
  },
};
