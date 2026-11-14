import { Type } from "@google/genai";
import type { Prisma } from "@prisma/client";

/**
 * Structured meeting intelligence.
 *
 * Grew out of the original five-field summary; the earlier fields kept
 * their names so summaries stored before the expansion still parse.
 * `parseStructuredSummary` fills anything a stored row predates, so
 * older meetings render with empty sections rather than breaking.
 */

export const SENTIMENTS = [
  "POSITIVE",
  "NEUTRAL",
  "NEGATIVE",
  "MIXED",
] as const;

export type Sentiment = (typeof SENTIMENTS)[number];

export const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export type Priority = (typeof PRIORITIES)[number];

export interface ActionItem {
  task: string;
  owner: string | null;
  dueDate: string | null;
  priority: Priority;
}

export interface ImportantDate {
  date: string;
  description: string;
}

export interface DiscussionTopic {
  topic: string;
  summary: string;
}

export interface MeetingSentiment {
  overall: Sentiment;
  /** One sentence explaining the reading, shown under the label. */
  rationale: string;
}

export interface StructuredSummary {
  executiveSummary: string;
  keyDecisions: string[];
  actionItems: ActionItem[];
  importantDates: ImportantDate[];
  followUps: string[];

  risks: string[];
  blockers: string[];
  openQuestions: string[];
  discussionTopics: DiscussionTopic[];
  keywords: string[];
  sentiment: MeetingSentiment;
}

const isSentiment = (value: unknown): value is Sentiment =>
  typeof value === "string" &&
  (SENTIMENTS as readonly string[]).includes(value);

const isPriority = (value: unknown): value is Priority =>
  typeof value === "string" &&
  (PRIORITIES as readonly string[]).includes(value);

export const asSentiment = (value: unknown): Sentiment =>
  isSentiment(value) ? value : "NEUTRAL";

export const asPriority = (value: unknown): Priority =>
  isPriority(value) ? value : "MEDIUM";

/**
 * Prisma's Json input type requires an index signature, which a plain
 * interface does not provide. Building the object against Prisma's own
 * InputJsonObject keeps the value fully typed and avoids an `any` cast
 * at the call site.
 */
export const toJsonValue = (
  summary: StructuredSummary
): Prisma.InputJsonObject => ({
  executiveSummary: summary.executiveSummary,
  keyDecisions: summary.keyDecisions,
  actionItems: summary.actionItems.map((item) => ({
    task: item.task,
    owner: item.owner,
    dueDate: item.dueDate,
    priority: item.priority,
  })),
  importantDates: summary.importantDates.map((entry) => ({
    date: entry.date,
    description: entry.description,
  })),
  followUps: summary.followUps,
  risks: summary.risks,
  blockers: summary.blockers,
  openQuestions: summary.openQuestions,
  discussionTopics: summary.discussionTopics.map((topic) => ({
    topic: topic.topic,
    summary: topic.summary,
  })),
  keywords: summary.keywords,
  sentiment: {
    overall: summary.sentiment.overall,
    rationale: summary.sentiment.rationale,
  },
});

const stringList = (description: string) => ({
  type: Type.ARRAY,
  description,
  items: { type: Type.STRING },
});

/**
 * Sent to Gemini as responseSchema so the model returns parseable
 * JSON instead of free-form markdown.
 *
 * Nullable fields are used rather than optional ones: the API requires
 * every property listed in `required`, and an explicit null is easier
 * to handle than a missing key.
 */
export const SUMMARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    executiveSummary: {
      type: Type.STRING,
      description:
        "Two to four sentences describing what the meeting covered.",
    },

    keyDecisions: stringList("Decisions that were actually agreed on."),

    actionItems: {
      type: Type.ARRAY,
      description: "Concrete tasks someone must carry out.",
      items: {
        type: Type.OBJECT,
        properties: {
          task: {
            type: Type.STRING,
            description: "What needs to be done.",
          },
          owner: {
            type: Type.STRING,
            nullable: true,
            description:
              "Who is responsible, or null if the transcript does " +
              "not say.",
          },
          dueDate: {
            type: Type.STRING,
            nullable: true,
            description:
              "Due date exactly as stated in the transcript, or " +
              "null. Do not invent or resolve relative dates.",
          },
          priority: {
            type: Type.STRING,
            enum: [...PRIORITIES],
            description:
              "How urgent the task sounded. Use MEDIUM when the " +
              "transcript gives no signal.",
          },
        },
        required: ["task", "owner", "dueDate", "priority"],
      },
    },

    importantDates: {
      type: Type.ARRAY,
      description: "Dates and deadlines mentioned in the meeting.",
      items: {
        type: Type.OBJECT,
        properties: {
          date: {
            type: Type.STRING,
            description: "The date as stated in the transcript.",
          },
          description: {
            type: Type.STRING,
            description: "What happens on that date.",
          },
        },
        required: ["date", "description"],
      },
    },

    followUps: stringList("Topics deferred to a later meeting."),

    risks: stringList(
      "Things that could go wrong, raised as concerns or threats to " +
        "the plan."
    ),

    blockers: stringList(
      "Problems currently stopping work from progressing. A blocker " +
        "is happening now; a risk might happen later."
    ),

    openQuestions: stringList(
      "Questions raised but left unanswered in this meeting."
    ),

    discussionTopics: {
      type: Type.ARRAY,
      description: "The main subjects discussed, in order.",
      items: {
        type: Type.OBJECT,
        properties: {
          topic: {
            type: Type.STRING,
            description: "Short label, a few words at most.",
          },
          summary: {
            type: Type.STRING,
            description: "One sentence on what was said about it.",
          },
        },
        required: ["topic", "summary"],
      },
    },

    keywords: stringList(
      "Five to twelve significant terms: projects, technologies, " +
        "products, or teams named in the meeting. Single words or " +
        "short phrases, no generic filler."
    ),

    sentiment: {
      type: Type.OBJECT,
      description: "The overall tone of the meeting.",
      properties: {
        overall: {
          type: Type.STRING,
          enum: [...SENTIMENTS],
          description:
            "MIXED when the tone genuinely varied; NEUTRAL for a " +
            "routine, matter-of-fact meeting.",
        },
        rationale: {
          type: Type.STRING,
          description: "One sentence justifying the reading.",
        },
      },
      required: ["overall", "rationale"],
    },
  },

  required: [
    "executiveSummary",
    "keyDecisions",
    "actionItems",
    "importantDates",
    "followUps",
    "risks",
    "blockers",
    "openQuestions",
    "discussionTopics",
    "keywords",
    "sentiment",
  ],
};

/**
 * Condensed shape used for rolling summaries during a live meeting.
 *
 * Deliberately smaller than the full schema: it runs every few minutes
 * on partial audio, where a risk register or sentiment reading would
 * be noise.
 */
export interface RollingSummaryData {
  headline: string;
  recentPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
}

export const ROLLING_SUMMARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    headline: {
      type: Type.STRING,
      description:
        "One sentence on where the meeting currently stands.",
    },
    recentPoints: stringList(
      "Three to six bullets covering what has been discussed so far."
    ),
    decisions: stringList("Decisions reached so far."),
    actionItems: {
      type: Type.ARRAY,
      description: "Tasks assigned so far.",
      items: {
        type: Type.OBJECT,
        properties: {
          task: { type: Type.STRING },
          owner: { type: Type.STRING, nullable: true },
          dueDate: { type: Type.STRING, nullable: true },
          priority: { type: Type.STRING, enum: [...PRIORITIES] },
        },
        required: ["task", "owner", "dueDate", "priority"],
      },
    },
    openQuestions: stringList("Questions still unanswered."),
  },
  required: [
    "headline",
    "recentPoints",
    "decisions",
    "actionItems",
    "openQuestions",
  ],
};

export const toRollingJsonValue = (
  data: RollingSummaryData
): Prisma.InputJsonObject => ({
  headline: data.headline,
  recentPoints: data.recentPoints,
  decisions: data.decisions,
  actionItems: data.actionItems.map((item) => ({
    task: item.task,
    owner: item.owner,
    dueDate: item.dueDate,
    priority: item.priority,
  })),
  openQuestions: data.openQuestions,
});

/* =========================================================
   Schema version 2: evidence-backed, mode-aware summaries
   ========================================================= */

/**
 * Version stored in Summary.data.schemaVersion. Rows without the field
 * are version 1 (the shape above) and still render: readers branch on
 * `isSummaryV2` and fall back to `parseStructuredSummary`.
 */
export const SUMMARY_SCHEMA_VERSION = 2;

/** Summary flavours. AUTO is a setting, never an effective mode. */
export const SUMMARY_MODES = [
  "GENERAL",
  "LECTURE",
  "INTERVIEW",
  "PROJECT",
  "ONE_ON_ONE",
] as const;

export type SummaryMode = (typeof SUMMARY_MODES)[number];

/** What Meeting.mode may hold. */
export const MODE_SETTINGS = [...SUMMARY_MODES, "AUTO"] as const;

export type ModeSetting = (typeof MODE_SETTINGS)[number];

export const isSummaryMode = (value: unknown): value is SummaryMode =>
  typeof value === "string" &&
  (SUMMARY_MODES as readonly string[]).includes(value);

export const isModeSetting = (value: unknown): value is ModeSetting =>
  typeof value === "string" &&
  (MODE_SETTINGS as readonly string[]).includes(value);

/** Accepts "lecture", "one-on-one", "ONE_ON_ONE"...; null if unknown. */
export const normalizeModeSetting = (value: unknown): ModeSetting | null => {
  if (typeof value !== "string") return null;

  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, "_");

  return isModeSetting(upper) ? upper : null;
};

/** TranscriptSegment.noiseLabel values written by the CLEAN pass. */
export const NOISE_LABELS = [
  "substantive",
  "small_talk",
  "logistics",
  "filler",
  "off_topic",
] as const;

export type NoiseLabel = (typeof NOISE_LABELS)[number];

export const isNoiseLabel = (value: unknown): value is NoiseLabel =>
  typeof value === "string" &&
  (NOISE_LABELS as readonly string[]).includes(value);

/** Below this confidence an item is shown as "needs review". */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.6;

/** Length caps applied in code after VERIFY, whatever the model did. */
export const SUMMARY_CAPS = {
  tldrSentences: 3,
  keyPoints: 7,
  listItems: 12,
  itemChars: 400,
} as const;

/**
 * One supporting segment. `idx` is TranscriptSegment.idx (never an
 * array position); speaker and startMs are copied from the segment row
 * by code, not trusted from the model, so the UI can show a chip
 * without loading the transcript.
 */
export interface Evidence {
  idx: number;
  speaker: string;
  startMs: number;
}

/**
 * Fields every summary item carries. `E` is the evidence type: plain
 * idx numbers as the model returns them, `Evidence` once validated.
 */
export interface Sourced<E = Evidence> {
  evidence: E[];
  /** 0..1, set by VERIFY. */
  confidence: number;
  /** confidence < REVIEW_CONFIDENCE_THRESHOLD. */
  needsReview: boolean;
}

export interface SummaryItem<E = Evidence> extends Sourced<E> {
  text: string;
}

export interface DecisionItem<E = Evidence> extends Sourced<E> {
  text: string;
  /** Who made or announced the decision, when stated. */
  decidedBy: string | null;
}

export interface ActionItemV2<E = Evidence> extends Sourced<E> {
  task: string;
  owner: string | null;
  /** Who handed the task out, when it is not the owner. */
  assignedBy: string | null;
  /** Deadline exactly as spoken ("by Friday"). */
  dueSpoken: string | null;
  /** dueSpoken resolved by lib/dates ("YYYY-MM-DD"), or null. */
  dueDate: string | null;
  priority: Priority;
}

export interface DateItem<E = Evidence> extends Sourced<E> {
  /** The date as spoken. */
  spoken: string;
  /** Resolved by lib/dates, or null. */
  date: string | null;
  description: string;
}

export interface SpeakerPoint<E = Evidence> extends Sourced<E> {
  speaker: string;
  text: string;
}

export interface GlossaryEntry<E = Evidence> extends Sourced<E> {
  term: string;
  definition: string;
}

/* ---------- per-mode sections ---------- */

export interface ExamQuestion<E = Evidence> extends Sourced<E> {
  question: string;
  /** Why it is expected: the lecturer's words, or the emphasis. */
  reason: string;
}

export interface Formula<E = Evidence> extends Sourced<E> {
  expression: string;
  meaning: string;
}

export interface Assignment<E = Evidence> extends Sourced<E> {
  task: string;
  dueSpoken: string | null;
  dueDate: string | null;
}

export interface LectureSection<E = Evidence> {
  outline: SummaryItem<E>[];
  definitions: GlossaryEntry<E>[];
  formulas: Formula<E>[];
  examQuestions: {
    /** The lecturer said it will be on the exam. */
    flaggedByLecturer: ExamQuestion<E>[];
    /** Inferred from emphasis; each has a reason. */
    likely: ExamQuestion<E>[];
  };
  assignments: Assignment<E>[];
  studyChecklist: SummaryItem<E>[];
}

export interface InterviewQA<E = Evidence> extends Sourced<E> {
  question: string;
  answerSummary: string;
}

export interface InterviewSection<E = Evidence> {
  qa: InterviewQA<E>[];
  followUps: SummaryItem<E>[];
  strengths: SummaryItem<E>[];
  concerns: SummaryItem<E>[];
  nextSteps: SummaryItem<E>[];
  /** Questions the recording user answered weakly. */
  struggledWith: SummaryItem<E>[];
}

export interface PersonStatus<E = Evidence> {
  name: string;
  done: SummaryItem<E>[];
  next: SummaryItem<E>[];
  blockers: SummaryItem<E>[];
}

export interface ProjectSection<E = Evidence> {
  people: PersonStatus<E>[];
  risks: SummaryItem<E>[];
}

export interface Commitment<E = Evidence> extends Sourced<E> {
  who: string;
  text: string;
}

export interface OneOnOneSection<E = Evidence> {
  feedback: SpeakerPoint<E>[];
  commitments: Commitment<E>[];
  nextTopics: SummaryItem<E>[];
}

export interface ModeSections<E = Evidence> {
  lecture?: LectureSection<E>;
  interview?: InterviewSection<E>;
  project?: ProjectSection<E>;
  oneOnOne?: OneOnOneSection<E>;
}

/** The part of a v2 summary the model produces (pre- and post-verify). */
export interface SummaryBody<E = Evidence> {
  tldr: string;
  keyPoints: SummaryItem<E>[];
  decisions: DecisionItem<E>[];
  actionItems: ActionItemV2<E>[];
  dates: DateItem<E>[];
  openQuestions: SummaryItem<E>[];
  whoSaidWhat: SpeakerPoint<E>[];
  glossary: GlossaryEntry<E>[];
  nextSessionPrep: SummaryItem<E>[];
  keywords: string[];
  sentiment: MeetingSentiment;
  sections: ModeSections<E>;
}

export interface DetectedMode {
  mode: SummaryMode;
  confidence: number;
  reason: string;
}

/** Stored in Summary.data for schemaVersion 2. */
export interface SummaryV2 extends SummaryBody<Evidence> {
  schemaVersion: typeof SUMMARY_SCHEMA_VERSION;
  /** The mode the summary was written for. */
  mode: SummaryMode;
  /** Meeting.mode (or the user's override) when it ran; AUTO or a mode. */
  modeSetting: ModeSetting;
  /** AUTO's guess, so the UI can show it and offer a change. */
  detectedMode: DetectedMode | null;
  /** Prompt ids and versions that produced this summary. */
  prompts: Record<string, string>;
  /** Pipeline bookkeeping, for debugging and evaluation. */
  stats: {
    segments: number;
    substantiveSegments: number;
    chunks: number;
    droppedItems: number;
    timezone: string;
    meetingStart: string;
  };
}

export const isSummaryV2 = (value: unknown): value is SummaryV2 =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>).schemaVersion === SUMMARY_SCHEMA_VERSION;

/**
 * Prisma JSON input from a v2 summary. The object is plain JSON by
 * construction (strings, numbers, booleans, nulls, arrays, objects), so
 * a round trip only drops `undefined` optional sections, which is what
 * we want stored.
 */
export const toJsonValueV2 = (summary: SummaryV2): Prisma.InputJsonObject =>
  JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonObject;

const texts = (items: { text: string }[]) => items.map((item) => item.text);

/**
 * Projects a v2 summary onto the version 1 shape, so code that reads
 * StructuredSummary (analytics, older clients) keeps working on new
 * rows without knowing about evidence or modes.
 */
export const toLegacyView = <E>(summary: SummaryBody<E>): StructuredSummary => {
  const project = summary.sections.project;

  return {
    executiveSummary: summary.tldr,
    keyDecisions: texts(summary.decisions),
    actionItems: summary.actionItems.map((item) => ({
      task: item.task,
      owner: item.owner,
      dueDate: item.dueSpoken,
      priority: item.priority,
    })),
    importantDates: summary.dates.map((entry) => ({
      date: entry.spoken,
      description: entry.description,
    })),
    followUps: texts(summary.nextSessionPrep),
    risks: project ? texts(project.risks) : [],
    blockers: project
      ? project.people.flatMap((person) => texts(person.blockers))
      : [],
    openQuestions: texts(summary.openQuestions),
    discussionTopics: summary.keyPoints.map((point) => ({
      topic: point.text.split(/[.:;]/)[0].slice(0, 60),
      summary: point.text,
    })),
    keywords: summary.keywords,
    sentiment: summary.sentiment,
  };
};
