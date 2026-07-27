import { Type } from "@google/genai";
import type { Prisma } from "@prisma/client";

export interface ActionItem {
  task: string;
  owner: string | null;
  dueDate: string | null;
}

export interface ImportantDate {
  date: string;
  description: string;
}

export interface StructuredSummary {
  executiveSummary: string;
  keyDecisions: string[];
  actionItems: ActionItem[];
  importantDates: ImportantDate[];
  followUps: string[];
}

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
  })),
  importantDates: summary.importantDates.map((entry) => ({
    date: entry.date,
    description: entry.description,
  })),
  followUps: summary.followUps,
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
    keyDecisions: {
      type: Type.ARRAY,
      description: "Decisions that were actually agreed on.",
      items: { type: Type.STRING },
    },
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
        },
        required: ["task", "owner", "dueDate"],
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
    followUps: {
      type: Type.ARRAY,
      description:
        "Open questions or topics deferred to a later meeting.",
      items: { type: Type.STRING },
    },
  },
  required: [
    "executiveSummary",
    "keyDecisions",
    "actionItems",
    "importantDates",
    "followUps",
  ],
};
