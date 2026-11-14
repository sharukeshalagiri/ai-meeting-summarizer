import { Type } from "@google/genai";
import { list, textItem } from "../schemas.v1";
import type { ModePromptDefinition } from "../types";

/** PROJECT: per-person status and the risks to the plan. */
export const projectV1: ModePromptDefinition = {
  id: "mode.project",
  version: 1,
  sectionKey: "project",
  system: `
This session is a PROJECT meeting. Fill sections.project:
- people: one entry per person with project status. done = work they
  reported finished; next = what they will do next (usually their
  action items, one short line each); blockers = what is stopping them
  now. Leave a list empty when nothing was said.
- risks: things that could go wrong later, raised as concerns. A
  blocker is happening now; a risk might happen later.
`.trim(),
  schema: {
    type: Type.OBJECT,
    properties: {
      people: list(
        {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            done: textItem("Finished work."),
            next: textItem("Next work."),
            blockers: textItem("Current blockers."),
          },
          required: ["name", "done", "next", "blockers"],
        },
        "Status per person."
      ),
      risks: textItem("Risks to the plan."),
    },
    required: ["people", "risks"],
  },
};
