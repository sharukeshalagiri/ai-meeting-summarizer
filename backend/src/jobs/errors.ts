import { AppError, toUserMessage } from "../types/errors";

/**
 * Readable, user-safe failure reasons for Meeting.processingError.
 *
 * Format: "[<STAGE>/<KIND>] <message>", e.g.
 * "[SUMMARIZING/RATE_LIMITED] The AI service is rate limited or out of
 * quota. Retry later from this page." The prefix is stable so the page
 * can show which step failed; the message never contains upstream or
 * database error text (only AppError messages, which are written to be
 * shown, or a fixed message per kind).
 */

export const FailureKind = {
  /** Gemini 429 / quota. Retried with backoff; may need hours (daily quota). */
  RATE_LIMITED: "RATE_LIMITED",
  /** Gemini 503 / overloaded, or another upstream 5xx. Retried. */
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
  /** Bad or missing API key. Not retried: retrying cannot fix it. */
  AI_AUTH: "AI_AUTH",
  /** The ai-service (Whisper) could not be reached or timed out. Retried. */
  ASR_UNREACHABLE: "ASR_UNREACHABLE",
  /** The database could not be reached. Retried. */
  DB_UNAVAILABLE: "DB_UNAVAILABLE",
  /** Nothing to process (no audio, no segments). Not retried. */
  BAD_INPUT: "BAD_INPUT",
  /** Anything else: a bug or an unexpected error. Not retried. */
  INTERNAL: "INTERNAL",
} as const;

export type FailureKindValue = (typeof FailureKind)[keyof typeof FailureKind];

export interface Failure {
  kind: FailureKindValue;
  /** Worth another attempt by the queue (transient). */
  retryable: boolean;
  /** User-safe text, without the prefix. */
  message: string;
}

/** Fixed messages for kinds whose original message is not shown. */
export const FAILURE_MESSAGES: Record<FailureKindValue, string> = {
  RATE_LIMITED:
    "The AI service is rate limited or out of quota. Retry later from this page.",
  AI_UNAVAILABLE:
    "The AI service is temporarily unavailable. Retry in a few minutes.",
  AI_AUTH: "The AI service rejected our credentials. Check GEMINI_API_KEY.",
  ASR_UNREACHABLE:
    "The transcription service could not be reached. Check that it is running, then retry.",
  DB_UNAVAILABLE: "The database could not be reached. Retry in a moment.",
  BAD_INPUT: "There was nothing to process.",
  INTERNAL: "The step failed unexpectedly. Retry from this page.",
};

/**
 * Sorts an error into a kind. AppErrors carry user-safe messages written
 * by lib/gemini.ts (toGeminiError) and speech.service; anything else is
 * INTERNAL and its text is never shown.
 */
export const classifyError = (error: unknown, stage?: string): Failure => {
  const fixed = (kind: FailureKindValue, retryable: boolean): Failure => ({
    kind,
    retryable,
    message: FAILURE_MESSAGES[kind],
  });

  if (error instanceof AppError) {
    const text = error.message;

    if (/rate limited|quota|429/i.test(text)) return fixed("RATE_LIMITED", true);
    if (/credentials|api[_ ]?key/i.test(text)) return fixed("AI_AUTH", false);
    // speech.service / the transcription providers only run in these
    // stages, so a 5xx there is the ASR, not Gemini.
    if (error.status >= 500 && (stage === "TRANSCRIBING" || stage === "ASSEMBLING")) {
      return fixed("ASR_UNREACHABLE", true);
    }
    if (error.status >= 500) return fixed("AI_UNAVAILABLE", true);

    // 4xx AppErrors are written to be shown ("No audio uploaded ...").
    return { kind: "BAD_INPUT", retryable: false, message: text };
  }

  if (toUserMessage(error).status === 503) return fixed("DB_UNAVAILABLE", true);

  return fixed("INTERNAL", false);
};

export const formatFailure = (stage: string, failure: Pick<Failure, "kind" | "message">): string =>
  `[${stage}/${failure.kind}] ${failure.message}`;

/** Parses a processingError back into its parts (null for free text). */
export const parseFailure = (
  value: string | null | undefined
): { stage: string; kind: string; message: string } | null => {
  const match = /^\[([A-Z_]+)\/([A-Z_]+)\] ([\s\S]*)$/.exec(value ?? "");
  return match ? { stage: match[1], kind: match[2], message: match[3] } : null;
};

/** Thrown by a handler to fail its job without a retry. */
export class PermanentJobError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

/** User-safe processingError notes that are not failures. */
export const PROCESSING_NOTES = {
  V2_FALLBACK:
    "The detailed summary could not be generated, so a basic summary was used instead.",
} as const;

/** processingError when the summary fails for an unexpected reason. */
export const SUMMARY_FAILED = formatFailure("SUMMARIZING", {
  kind: "INTERNAL",
  message: "The summary could not be generated. Retry from the meeting page.",
});
