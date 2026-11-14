import { Type } from "@google/genai";
import { NOISE_LABELS, PRIORITIES, SENTIMENTS, SUMMARY_MODES } from "../types/summary";

/**
 * Gemini responseSchemas for the summary pipeline, version 1.
 *
 * Kept next to the prompts because the two are one contract: the prompt
 * explains the fields the schema declares. Nullable fields are used
 * instead of optional ones (the API wants every `required` key), and
 * every response is still validated by the narrowing parsers in
 * services/w1-sum.parsers.ts.
 */

type Schema = Record<string, unknown>;

const str = (description?: string): Schema => ({
  type: Type.STRING,
  ...(description ? { description } : {}),
});

const nullableStr = (description: string): Schema => ({
  type: Type.STRING,
  nullable: true,
  description,
});

const evidence: Schema = {
  type: Type.ARRAY,
  description:
    "Segment ids ([#id] markers) of the lines that support this item.",
  items: { type: Type.INTEGER },
};

const confidence: Schema = {
  type: Type.NUMBER,
  description: "0 to 1: how clearly the transcript supports the item.",
};

/** An object with `evidence` and `confidence` added to `fields`. */
export const sourced = (
  fields: Record<string, Schema>,
  description?: string
): Schema => ({
  type: Type.OBJECT,
  ...(description ? { description } : {}),
  properties: { ...fields, evidence, confidence },
  required: [...Object.keys(fields), "evidence", "confidence"],
});

export const list = (item: Schema, description: string): Schema => ({
  type: Type.ARRAY,
  description,
  items: item,
});

export const textItem = (description: string): Schema =>
  list(sourced({ text: str() }), description);

const object = (properties: Record<string, Schema>, description?: string): Schema => ({
  type: Type.OBJECT,
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
});

/* ---------- CLASSIFY ---------- */

export const CLASSIFY_SCHEMA_V1: Schema = object({
  mode: { type: Type.STRING, enum: [...SUMMARY_MODES] },
  confidence,
  reason: str("One short sentence on why."),
});

/* ---------- CLEAN ---------- */

export const CLEAN_SCHEMA_V1: Schema = object({
  labels: list(
    object({
      idx: { type: Type.INTEGER },
      label: { type: Type.STRING, enum: [...NOISE_LABELS] },
    }),
    "One entry per segment id given."
  ),
});

/* ---------- EXTRACT / REDUCE / VERIFY ---------- */

/** The common body; `sections` is added per mode. */
const BODY_PROPERTIES: Record<string, Schema> = {
  tldr: str("At most three sentences: what happened and what matters."),
  keyPoints: textItem("At most seven key points, most important first."),
  decisions: list(
    sourced({
      text: str("What was decided."),
      decidedBy: nullableStr("Who decided or announced it, or null."),
    }),
    "Decisions that were actually agreed, not proposals or jokes."
  ),
  actionItems: list(
    sourced({
      task: str("What must be done, starting with a verb."),
      owner: nullableStr("Who will do it, or null if not stated."),
      assignedBy: nullableStr(
        "Who asked for it, when that is not the owner; otherwise null."
      ),
      dueSpoken: nullableStr(
        "The deadline exactly as spoken, or null. Never a calendar date you computed."
      ),
      priority: { type: Type.STRING, enum: [...PRIORITIES] },
    }),
    "Concrete tasks someone committed to or was given."
  ),
  dates: list(
    sourced({
      spoken: str("The date or deadline exactly as spoken."),
      description: str("What happens then."),
    }),
    "Dates and deadlines mentioned for real work, not social plans."
  ),
  openQuestions: textItem("Questions raised and left unanswered."),
  whoSaidWhat: list(
    sourced({
      speaker: str("Speaker name as in the transcript."),
      text: str("Their main contribution, one sentence."),
    }),
    "One entry per speaker who contributed substance."
  ),
  glossary: list(
    sourced({ term: str(), definition: str() }),
    "Jargon, acronyms or terms that were explained."
  ),
  nextSessionPrep: textItem(
    "What to prepare or revisit before the next session."
  ),
  keywords: list(str(), "Five to twelve significant terms."),
  sentiment: object({
    overall: { type: Type.STRING, enum: [...SENTIMENTS] },
    rationale: str("One sentence."),
  }),
};

/**
 * Full response schema for EXTRACT, REDUCE and VERIFY. `section` is the
 * active mode's section schema (none for GENERAL).
 */
export const summaryBodySchemaV1 = (
  section?: { key: string; schema: Schema }
): Schema =>
  object({
    ...BODY_PROPERTIES,
    sections: section
      ? object({ [section.key]: section.schema }, "Mode-specific sections.")
      : {
          type: Type.OBJECT,
          description: "Leave empty.",
          nullable: true,
          properties: {
            none: { type: Type.STRING, nullable: true },
          },
        },
  });
