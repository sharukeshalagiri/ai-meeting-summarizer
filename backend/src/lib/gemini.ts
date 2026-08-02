import { GoogleGenAI } from "@google/genai";
import { env } from "./env";
import { logger } from "./logger";
import { AppError, UpstreamError } from "../types/errors";

/**
 * Shared Gemini access: one client, one retry policy, one mapping from
 * upstream failures to user-facing messages.
 *
 * Summaries, diarization, chat, and embeddings all call the same API
 * and fail in the same ways, so this lives here rather than being
 * repeated in each service.
 */

const log = logger.child({ module: "gemini" });

let client: GoogleGenAI | null = null;

/**
 * Built on first use rather than at import time. env.ts validates the
 * key at startup, so this only avoids constructing a client that may
 * never be needed.
 */
export const getClient = (): GoogleGenAI => {
  if (!client) {
    client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  }

  return client;
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
export async function withRetry<T>(
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

      log.warn("Gemini call failed, retrying", {
        attempt: attempt + 1,
        attempts,
        delayMs: delay,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Turns a Gemini failure into an AppError safe to show a user.
 *
 * `fallback` describes the operation that failed, so the message can
 * say what did not happen without leaking upstream detail.
 */
export const toGeminiError = (
  error: unknown,
  fallback: string
): AppError => {
  // Configuration and validation problems are already user-facing.
  if (error instanceof AppError) {
    return error;
  }

  const detail = error instanceof Error ? error.message : String(error);

  // The wrapped messages below are deliberately generic, so keep the
  // upstream detail in the logs for diagnosis.
  log.error("Gemini request failed", error, { detail });

  if (/api[_ ]?key|permission|unauthenticated|401|403/i.test(detail)) {
    return UpstreamError(
      "The AI service rejected our credentials. Check GEMINI_API_KEY."
    );
  }

  if (/quota|rate.?limit|429/i.test(detail)) {
    return UpstreamError(
      "The AI service is rate limited. Please try again in a moment."
    );
  }

  if (/unavailable|overloaded|high demand|503/i.test(detail)) {
    return UpstreamError(
      "The AI service is temporarily overloaded. Please try again in " +
        "a minute."
    );
  }

  return UpstreamError(fallback);
};

/**
 * Parses a schema-constrained JSON response.
 *
 * Even with responseSchema set the result arrives as text, so it is
 * parsed and shape-checked before any caller trusts it.
 */
export const parseJsonResponse = (
  raw: string,
  what: string
): Record<string, unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw UpstreamError(
      `The AI service returned a ${what} we could not read. Please ` +
        `try again.`
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw UpstreamError(
      `The AI service returned an unexpected ${what}.`
    );
  }

  return parsed as Record<string, unknown>;
};
