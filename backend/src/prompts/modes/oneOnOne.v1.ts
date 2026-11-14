import { Type } from "@google/genai";
import { list, sourced, textItem } from "../schemas.v1";
import type { ModePromptDefinition } from "../types";

const str = { type: Type.STRING };

/** ONE_ON_ONE: feedback given, promises made on both sides. */
export const oneOnOneV1: ModePromptDefinition = {
  id: "mode.oneOnOne",
  version: 1,
  sectionKey: "oneOnOne",
  system: `
This session is a ONE_ON_ONE. Fill sections.oneOnOne:
- feedback: feedback one person gave the other; speaker is who gave
  it. Keep the wording neutral and specific.
- commitments: promises made on either side; who is the person who
  committed. Include both sides, not only the report's.
- nextTopics: topics they agreed to pick up next time.
`.trim(),
  schema: {
    type: Type.OBJECT,
    properties: {
      feedback: list(sourced({ speaker: str, text: str }), "Feedback given."),
      commitments: list(sourced({ who: str, text: str }), "Commitments, both sides."),
      nextTopics: textItem("Topics for next time."),
    },
    required: ["feedback", "commitments", "nextTopics"],
  },
};
