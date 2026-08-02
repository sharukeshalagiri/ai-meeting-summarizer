import { env } from "../lib/env";
import {
  getClient,
  parseJsonResponse,
  toGeminiError,
  withRetry,
} from "../lib/gemini";
import { logger } from "../lib/logger";
import { BadRequest, UpstreamError } from "../types/errors";
import {
  ROLLING_SUMMARY_SCHEMA,
  SUMMARY_SCHEMA,
  asPriority,
  asSentiment,
  type ActionItem,
  type DiscussionTopic,
  type ImportantDate,
  type MeetingSentiment,
  type RollingSummaryData,
  type StructuredSummary,
} from "../types/summary";

const log = logger.child({ module: "summary.service" });

const SYSTEM_INSTRUCTION = `
You are an AI Meeting Assistant. Extract structured intelligence from
meeting transcripts accurately and concisely.

Rules:
- Only use information present in the transcript. Never invent
  decisions, owners, dates, risks, or questions.
- Transcripts may be labelled with speakers and timestamps in the form
  "[12:34] Priya: ...". Use those labels to attribute action items and
  decisions to the right person. Never put a timestamp in your output.
- If an action item has no clear owner or due date, use null.
- Quote dates as the speaker stated them; do not convert relative
  dates into calendar dates.
- Distinguish a blocker (stopping work now) from a risk (might cause
  problems later).
- Return an empty array for any section the transcript does not cover.
  An empty section is correct and expected; padding it is not.
`.trim();

/** Narrowing helpers: the API is schema-constrained, but the response
 *  is still parsed JSON, so validate before trusting it. */
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asActionItems = (value: unknown): ActionItem[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    if (typeof item.task !== "string" || !item.task.trim()) return [];

    return [
      {
        task: item.task.trim(),
        owner: asNullableString(item.owner),
        dueDate: asNullableString(item.dueDate),
        priority: asPriority(item.priority),
      },
    ];
  });
};

const asImportantDates = (value: unknown): ImportantDate[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    if (typeof item.date !== "string" || !item.date.trim()) return [];

    return [
      {
        date: item.date.trim(),
        description:
          typeof item.description === "string"
            ? item.description.trim()
            : "",
      },
    ];
  });
};

const asDiscussionTopics = (value: unknown): DiscussionTopic[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    if (typeof item.topic !== "string" || !item.topic.trim()) return [];

    return [
      {
        topic: item.topic.trim(),
        summary:
          typeof item.summary === "string" ? item.summary.trim() : "",
      },
    ];
  });
};

const asMeetingSentiment = (value: unknown): MeetingSentiment => {
  if (typeof value !== "object" || value === null) {
    return { overall: "NEUTRAL", rationale: "" };
  }

  const item = value as Record<string, unknown>;

  return {
    overall: asSentiment(item.overall),
    rationale:
      typeof item.rationale === "string" ? item.rationale.trim() : "",
  };
};

/**
 * Validates a raw model response, and doubles as the reader for rows
 * stored before the schema was expanded: every field beyond the
 * original five degrades to empty rather than throwing.
 *
 * Exported so the parsing rules can be exercised without calling the
 * API.
 */
export const parseStructuredSummary = (
  raw: string | Record<string, unknown>
): StructuredSummary => {
  const value =
    typeof raw === "string" ? parseJsonResponse(raw, "summary") : raw;

  const executiveSummary =
    typeof value.executiveSummary === "string"
      ? value.executiveSummary.trim()
      : "";

  if (!executiveSummary) {
    throw UpstreamError(
      "The summary service returned an empty summary. Please try " +
        "again."
    );
  }

  return {
    executiveSummary,
    keyDecisions: asStringArray(value.keyDecisions),
    actionItems: asActionItems(value.actionItems),
    importantDates: asImportantDates(value.importantDates),
    followUps: asStringArray(value.followUps),

    risks: asStringArray(value.risks),
    blockers: asStringArray(value.blockers),
    openQuestions: asStringArray(value.openQuestions),
    discussionTopics: asDiscussionTopics(value.discussionTopics),
    keywords: asStringArray(value.keywords),
    sentiment: asMeetingSentiment(value.sentiment),
  };
};

/**
 * Renders the structured summary as markdown. Derived rather than
 * generated separately, so the two representations always agree.
 */
export const toMarkdown = (summary: StructuredSummary): string => {
  const section = (heading: string, lines: string[]): string =>
    `# ${heading}\n\n${
      lines.length ? lines.join("\n") : "_None recorded._"
    }`;

  const bullets = (lines: string[]) => lines.map((line) => `- ${line}`);

  const actionLines = summary.actionItems.map((item) => {
    const details = [
      item.owner ? `owner: ${item.owner}` : null,
      item.dueDate ? `due: ${item.dueDate}` : null,
      item.priority !== "MEDIUM"
        ? `priority: ${item.priority.toLowerCase()}`
        : null,
    ].filter(Boolean);

    return `- ${item.task}${
      details.length ? ` (${details.join(", ")})` : ""
    }`;
  });

  const dateLines = summary.importantDates.map((entry) =>
    entry.description
      ? `- **${entry.date}** — ${entry.description}`
      : `- **${entry.date}**`
  );

  const topicLines = summary.discussionTopics.map((entry) =>
    entry.summary
      ? `- **${entry.topic}** — ${entry.summary}`
      : `- **${entry.topic}**`
  );

  return [
    `# Executive Summary\n\n${summary.executiveSummary}`,
    section("Key Decisions", bullets(summary.keyDecisions)),
    section("Action Items", actionLines),
    section("Important Dates", dateLines),
    section("Risks", bullets(summary.risks)),
    section("Blockers", bullets(summary.blockers)),
    section("Open Questions", bullets(summary.openQuestions)),
    section("Discussion Topics", topicLines),
    section("Follow Ups", bullets(summary.followUps)),
    section("Keywords", bullets(summary.keywords)),
    `# Sentiment\n\n${summary.sentiment.overall}${
      summary.sentiment.rationale
        ? ` — ${summary.sentiment.rationale}`
        : ""
    }`,
  ].join("\n\n");
};

/**
 * Asks Gemini for schema-constrained meeting intelligence and returns
 * both the structured object and a markdown rendering of it.
 */
export async function generateSummary(
  transcript: string
): Promise<{ structured: StructuredSummary; markdown: string }> {
  if (!transcript.trim()) {
    throw BadRequest("There is no transcript text to summarize.");
  }

  try {
    const response = await withRetry(() =>
      getClient().models.generateContent({
        model: env.geminiModel,

        contents: `Transcript:\n${transcript}`,

        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: SUMMARY_SCHEMA,
        },
      })
    );

    const structured = parseStructuredSummary(response.text ?? "");

    return { structured, markdown: toMarkdown(structured) };
  } catch (error) {
    throw toGeminiError(
      error,
      "Could not generate a summary right now. Please try again."
    );
  }
}

const ROLLING_INSTRUCTION = `
You are an AI Meeting Assistant summarizing a meeting that is still in
progress.

Rules:
- Summarize only what has been said so far. The meeting is not over.
- Do not speculate about what will be decided later.
- Only use information present in the transcript.
- Return empty arrays for anything not yet covered.
`.trim();

/**
 * Point-in-time summary for a live meeting.
 *
 * Failures are the caller's to swallow: a missed rolling update should
 * never interrupt an ongoing capture.
 */
export async function generateRollingSummary(
  transcript: string
): Promise<RollingSummaryData> {
  if (!transcript.trim()) {
    throw BadRequest("There is no transcript text to summarize yet.");
  }

  try {
    const response = await withRetry(
      () =>
        getClient().models.generateContent({
          model: env.geminiModel,

          contents: `Meeting so far:\n${transcript}`,

          config: {
            systemInstruction: ROLLING_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema: ROLLING_SUMMARY_SCHEMA,
          },
        }),
      // One retry only: another chunk arrives within minutes, so a
      // slow recovery is worse than skipping this update.
      2
    );

    const value = parseJsonResponse(
      response.text ?? "",
      "rolling summary"
    );

    const headline =
      typeof value.headline === "string" ? value.headline.trim() : "";

    log.debug("Rolling summary generated", {
      characters: transcript.length,
    });

    return {
      headline: headline || "Meeting in progress.",
      recentPoints: asStringArray(value.recentPoints),
      decisions: asStringArray(value.decisions),
      actionItems: asActionItems(value.actionItems),
      openQuestions: asStringArray(value.openQuestions),
    };
  } catch (error) {
    throw toGeminiError(
      error,
      "Could not generate a live update right now."
    );
  }
}
