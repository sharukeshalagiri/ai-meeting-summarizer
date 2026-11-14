import {
  asPriority,
  asSentiment,
  isNoiseLabel,
  isSummaryMode,
  type DetectedMode,
  type InterviewSection,
  type LectureSection,
  type ModeSections,
  type NoiseLabel,
  type OneOnOneSection,
  type ProjectSection,
  type Sourced,
  type SummaryBody,
  type SummaryMode,
} from "../types/summary";

/**
 * Hand-written narrowing parsers for every summary-pipeline response.
 *
 * Gemini's responseSchema makes the JSON likely to be well-formed, not
 * guaranteed, so nothing from the model is trusted as typed: every
 * field is checked, malformed entries are dropped, and missing sections
 * become empty. Evidence comes out as raw idx numbers here; the pipeline
 * then checks them against the real segments.
 */

type Raw = Record<string, unknown>;

const asObject = (value: unknown): Raw | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : null;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const asText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

export const asNullableText = (value: unknown): string | null => {
  const text = asText(value);
  return text && !/^(null|none|n\/a|unknown)$/i.test(text) ? text : null;
};

/** 0..1; a missing or broken value counts as unsure (0.5). */
export const asConfidence = (value: unknown): number => {
  const number = typeof value === "string" ? Number(value) : value;

  if (typeof number !== "number" || !Number.isFinite(number)) return 0.5;

  // Some responses use 0-100.
  const scaled = number > 1 && number <= 100 ? number / 100 : number;

  return Math.min(1, Math.max(0, scaled));
};

/** Integer idx values; accepts 12, "12" and "#12". Duplicates removed. */
export const asEvidenceIds = (value: unknown): number[] => {
  const ids = asArray(value).flatMap((entry) => {
    const number =
      typeof entry === "number"
        ? entry
        : typeof entry === "string"
          ? Number(entry.replace(/^#/, "").trim())
          : NaN;

    return Number.isInteger(number) && number >= 0 ? [number] : [];
  });

  return [...new Set(ids)];
};

/**
 * Parses a list of evidence-backed items. `build` reads the item's own
 * fields and returns null to drop it (e.g. an empty task).
 */
const sourcedList = <T extends object>(
  value: unknown,
  build: (item: Raw) => T | null
): (T & Sourced<number>)[] =>
  asArray(value).flatMap((entry) => {
    const item = asObject(entry);
    if (!item) return [];

    const fields = build(item);
    if (!fields) return [];

    return [
      {
        ...fields,
        evidence: asEvidenceIds(item.evidence),
        confidence: asConfidence(item.confidence),
        needsReview: false,
      },
    ];
  });

const textItems = (value: unknown) =>
  sourcedList(value, (item) => {
    const text = asText(item.text);
    return text ? { text } : null;
  });

const stringList = (value: unknown): string[] =>
  [...new Set(asArray(value).map(asText).filter(Boolean))];

/* ---------- CLASSIFY ---------- */

export const parseClassification = (value: Raw): DetectedMode => ({
  mode: isSummaryMode(value.mode) ? value.mode : "GENERAL",
  confidence: asConfidence(value.confidence),
  reason: asText(value.reason),
});

/* ---------- CLEAN ---------- */

/**
 * Labels for the segments that were asked about. Unknown ids are
 * ignored; a segment the model skipped or mislabelled becomes
 * "substantive", because dropping real content is worse than keeping
 * a little noise.
 */
export const parseNoiseLabels = (
  value: Raw,
  askedIdx: number[]
): Map<number, NoiseLabel> => {
  const asked = new Set(askedIdx);
  const labels = new Map<number, NoiseLabel>();

  for (const entry of asArray(value.labels)) {
    const item = asObject(entry);
    if (!item) continue;

    const idx = Number(item.idx);
    const label = typeof item.label === "string" ? item.label.trim().toLowerCase() : "";

    if (asked.has(idx) && isNoiseLabel(label)) labels.set(idx, label);
  }

  for (const idx of askedIdx) {
    if (!labels.has(idx)) labels.set(idx, "substantive");
  }

  return labels;
};

/* ---------- mode sections ---------- */

const parseLecture = (value: unknown): LectureSection<number> | undefined => {
  const section = asObject(value);
  if (!section) return undefined;

  const exam = asObject(section.examQuestions) ?? {};
  const examList = (list: unknown) =>
    sourcedList(list, (item) => {
      const question = asText(item.question);
      return question ? { question, reason: asText(item.reason) } : null;
    });

  return {
    outline: textItems(section.outline),
    definitions: sourcedList(section.definitions, (item) => {
      const term = asText(item.term);
      return term ? { term, definition: asText(item.definition) } : null;
    }),
    formulas: sourcedList(section.formulas, (item) => {
      const expression = asText(item.expression);
      return expression ? { expression, meaning: asText(item.meaning) } : null;
    }),
    examQuestions: {
      flaggedByLecturer: examList(exam.flaggedByLecturer),
      likely: examList(exam.likely),
    },
    assignments: sourcedList(section.assignments, (item) => {
      const task = asText(item.task);
      return task
        ? { task, dueSpoken: asNullableText(item.dueSpoken), dueDate: null }
        : null;
    }),
    studyChecklist: textItems(section.studyChecklist),
  };
};

const parseInterview = (value: unknown): InterviewSection<number> | undefined => {
  const section = asObject(value);
  if (!section) return undefined;

  return {
    qa: sourcedList(section.qa, (item) => {
      const question = asText(item.question);
      return question
        ? { question, answerSummary: asText(item.answerSummary) }
        : null;
    }),
    followUps: textItems(section.followUps),
    strengths: textItems(section.strengths),
    concerns: textItems(section.concerns),
    nextSteps: textItems(section.nextSteps),
    struggledWith: textItems(section.struggledWith),
  };
};

const parseProject = (value: unknown): ProjectSection<number> | undefined => {
  const section = asObject(value);
  if (!section) return undefined;

  return {
    people: asArray(section.people).flatMap((entry) => {
      const person = asObject(entry);
      const name = person ? asText(person.name) : "";
      if (!person || !name) return [];

      return [
        {
          name,
          done: textItems(person.done),
          next: textItems(person.next),
          blockers: textItems(person.blockers),
        },
      ];
    }),
    risks: textItems(section.risks),
  };
};

const parseOneOnOne = (value: unknown): OneOnOneSection<number> | undefined => {
  const section = asObject(value);
  if (!section) return undefined;

  return {
    feedback: sourcedList(section.feedback, (item) => {
      const text = asText(item.text);
      return text ? { speaker: asText(item.speaker), text } : null;
    }),
    commitments: sourcedList(section.commitments, (item) => {
      const text = asText(item.text);
      return text ? { who: asText(item.who), text } : null;
    }),
    nextTopics: textItems(section.nextTopics),
  };
};

/** Only the active mode's section is read; anything else is ignored. */
export const parseSections = (
  value: unknown,
  mode: SummaryMode
): ModeSections<number> => {
  const sections = asObject(value) ?? {};

  switch (mode) {
    case "LECTURE": {
      const lecture = parseLecture(sections.lecture);
      return lecture ? { lecture } : {};
    }
    case "INTERVIEW": {
      const interview = parseInterview(sections.interview);
      return interview ? { interview } : {};
    }
    case "PROJECT": {
      const project = parseProject(sections.project);
      return project ? { project } : {};
    }
    case "ONE_ON_ONE": {
      const oneOnOne = parseOneOnOne(sections.oneOnOne);
      return oneOnOne ? { oneOnOne } : {};
    }
    default:
      return {};
  }
};

/* ---------- EXTRACT / REDUCE / VERIFY ---------- */

/** Parses a summary body from any of the three summarizing passes. */
export const parseSummaryBody = (
  value: Raw,
  mode: SummaryMode
): SummaryBody<number> => {
  const sentiment = asObject(value.sentiment) ?? {};

  return {
    tldr: asText(value.tldr),
    keyPoints: textItems(value.keyPoints),
    decisions: sourcedList(value.decisions, (item) => {
      const text = asText(item.text);
      return text ? { text, decidedBy: asNullableText(item.decidedBy) } : null;
    }),
    actionItems: sourcedList(value.actionItems, (item) => {
      const task = asText(item.task);
      if (!task) return null;

      const owner = asNullableText(item.owner);
      const assignedBy = asNullableText(item.assignedBy);

      return {
        task,
        owner,
        // "Assigned by" the owner themselves says nothing.
        assignedBy:
          assignedBy && assignedBy.toLowerCase() !== owner?.toLowerCase()
            ? assignedBy
            : null,
        dueSpoken: asNullableText(item.dueSpoken),
        dueDate: null,
        priority: asPriority(
          typeof item.priority === "string" ? item.priority.toUpperCase() : item.priority
        ),
      };
    }),
    dates: sourcedList(value.dates, (item) => {
      const spoken = asText(item.spoken);
      return spoken
        ? { spoken, date: null, description: asText(item.description) }
        : null;
    }),
    openQuestions: textItems(value.openQuestions),
    whoSaidWhat: sourcedList(value.whoSaidWhat, (item) => {
      const speaker = asText(item.speaker);
      const text = asText(item.text);
      return speaker && text ? { speaker, text } : null;
    }),
    glossary: sourcedList(value.glossary, (item) => {
      const term = asText(item.term);
      return term ? { term, definition: asText(item.definition) } : null;
    }),
    nextSessionPrep: textItems(value.nextSessionPrep),
    keywords: stringList(value.keywords),
    sentiment: {
      overall: asSentiment(sentiment.overall),
      rationale: asText(sentiment.rationale),
    },
    sections: parseSections(value.sections, mode),
  };
};
