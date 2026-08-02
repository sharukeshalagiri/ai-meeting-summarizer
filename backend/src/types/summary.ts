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
