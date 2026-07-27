import { GoogleGenAI } from "@google/genai";
import { AppError, BadRequest, UpstreamError } from "../types/errors";
import {
  SUMMARY_SCHEMA,
  type ActionItem,
  type ImportantDate,
  type StructuredSummary,
} from "../types/summary";

let client: GoogleGenAI | null = null;

// Constructed lazily: imports are hoisted above dotenv.config() in
// server.ts, so the key is not in process.env at module-eval time.
function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new AppError(
        "The summary service is not configured. Set GEMINI_API_KEY " +
          "in backend/.env.",
        500
      );
    }

    client = new GoogleGenAI({ apiKey });
  }

  return client;
}

const SYSTEM_INSTRUCTION = `
You are an AI Meeting Assistant. Summarize meeting transcripts
accurately and concisely.

Rules:
- Only use information present in the transcript. Never invent
  decisions, owners, or dates.
- If an action item has no clear owner or due date, use null.
- Quote dates as the speaker stated them; do not convert relative
  dates into calendar dates.
- Return an empty array for any section the transcript does not
  cover.
`.trim();

/** Narrowing helpers: the API is schema-constrained, but the response
 *  is still parsed JSON, so validate before trusting it. */
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const asActionItems = (value: unknown): ActionItem[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    if (typeof item.task !== "string" || !item.task.trim()) return [];

    return [
      {
        task: item.task,
        owner: asNullableString(item.owner),
        dueDate: asNullableString(item.dueDate),
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
        date: item.date,
        description:
          typeof item.description === "string" ? item.description : "",
      },
    ];
  });
};

/**
 * Validates a raw model response. Exported so the parsing rules can be
 * exercised without calling the API.
 */
export const parseStructuredSummary = (
  raw: string
): StructuredSummary => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw UpstreamError(
      "The summary service returned a response we could not read. " +
        "Please try again."
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw UpstreamError(
      "The summary service returned an unexpected response."
    );
  }

  const value = parsed as Record<string, unknown>;

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

  const actionLines = summary.actionItems.map((item) => {
    const details = [
      item.owner ? `owner: ${item.owner}` : null,
      item.dueDate ? `due: ${item.dueDate}` : null,
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

  return [
    `# Executive Summary\n\n${summary.executiveSummary}`,
    section(
      "Key Decisions",
      summary.keyDecisions.map((line) => `- ${line}`)
    ),
    section("Action Items", actionLines),
    section("Important Dates", dateLines),
    section(
      "Follow Ups",
      summary.followUps.map((line) => `- ${line}`)
    ),
  ].join("\n\n");
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Model overload (503) and rate limits are usually short-lived. */
const isTransient = (error: unknown): boolean => {
  const detail = error instanceof Error ? error.message : String(error);

  return /unavailable|overloaded|high demand|503|429|rate.?limit/i.test(
    detail
  );
};

/**
 * Retries transient upstream failures with a widening delay. Permanent
 * errors (bad key, invalid request) are rethrown on the first attempt.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransient(error) || attempt === attempts - 1) {
        throw error;
      }

      const delay = 1500 * (attempt + 1);

      console.warn(
        `Gemini call failed (attempt ${attempt + 1}/${attempts}), ` +
          `retrying in ${delay}ms`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Asks Gemini for a schema-constrained JSON summary and returns both
 * the structured object and a markdown rendering of it.
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
        model: "gemini-flash-latest",

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
    // Configuration and validation problems are already user-facing.
    if (error instanceof AppError) {
      throw error;
    }

    const detail =
      error instanceof Error ? error.message : String(error);

    // The wrapped message below is deliberately generic, so keep the
    // upstream detail in the logs for diagnosis.
    console.error("Gemini request failed:", detail);

    if (/api[_ ]?key|permission|unauthenticated|401|403/i.test(detail)) {
      throw UpstreamError(
        "The summary service rejected our credentials. Check " +
          "GEMINI_API_KEY."
      );
    }

    if (/quota|rate.?limit|429/i.test(detail)) {
      throw UpstreamError(
        "The summary service is rate limited. Please try again in a " +
          "moment."
      );
    }

    if (/unavailable|overloaded|high demand|503/i.test(detail)) {
      throw UpstreamError(
        "The summary service is temporarily overloaded. Please try " +
          "again in a minute."
      );
    }

    throw UpstreamError(
      "Could not generate a summary right now. Please try again."
    );
  }
}
