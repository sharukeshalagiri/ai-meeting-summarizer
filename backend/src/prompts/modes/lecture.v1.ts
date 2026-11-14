import { Type } from "@google/genai";
import { list, sourced, textItem } from "../schemas.v1";
import type { ModePromptDefinition } from "../types";

const str = { type: Type.STRING };
const nullableStr = { type: Type.STRING, nullable: true };

const examQuestion = sourced({
  question: str,
  reason: { type: Type.STRING, description: "Why it is expected." },
});

/** LECTURE: study notes a student can revise from. */
export const lectureV1: ModePromptDefinition = {
  id: "mode.lecture",
  version: 1,
  sectionKey: "lecture",
  system: `
This session is a LECTURE. Fill sections.lecture as study notes:
- outline: the lecture's topics in order.
- definitions: terms the lecturer defined, with the definition as
  given.
- formulas: formulas or rules stated, with what they mean.
- examQuestions.flaggedByLecturer: ONLY topics the lecturer explicitly
  said will be on the exam ("this will be on the exam"). Phrase each as
  an exam question; reason quotes the lecturer's flag. A student asking
  about the exam does not flag anything, and a remark the lecturer says
  is NOT on the exam must not appear anywhere.
- examQuestions.likely: topics the lecturer stressed without saying
  "exam"; reason says what made it stand out. May be empty.
- assignments: homework or tasks students must hand in, with the
  deadline as spoken. Optional or suggested reading is not an
  assignment.
- studyChecklist: short "be able to ..." items covering the material.
In LECTURE mode put homework in assignments, not in actionItems.
`.trim(),
  schema: {
    type: Type.OBJECT,
    properties: {
      outline: textItem("Topics in order."),
      definitions: list(sourced({ term: str, definition: str }), "Terms defined."),
      formulas: list(sourced({ expression: str, meaning: str }), "Formulas stated."),
      examQuestions: {
        type: Type.OBJECT,
        properties: {
          flaggedByLecturer: list(examQuestion, "Explicitly flagged for the exam."),
          likely: list(examQuestion, "Stressed but not flagged."),
        },
        required: ["flaggedByLecturer", "likely"],
      },
      assignments: list(
        sourced({ task: str, dueSpoken: nullableStr }),
        "Homework students must hand in."
      ),
      studyChecklist: textItem("Be able to ... items."),
    },
    required: [
      "outline",
      "definitions",
      "formulas",
      "examQuestions",
      "assignments",
      "studyChecklist",
    ],
  },
};
