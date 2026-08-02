import { env } from "../lib/env";
import {
  getClient,
  parseJsonResponse,
  toGeminiError,
  withRetry,
} from "../lib/gemini";
import { logger } from "../lib/logger";
import {
  DIARIZATION_SCHEMA,
  formatTimestamp,
  type DiarizedSegment,
  type RawSegment,
} from "../types/segment";

const log = logger.child({ module: "diarization.service" });

/**
 * Speaker attribution.
 *
 * Whisper transcribes but does not diarize, and the usual answer
 * (pyannote.audio) needs a gated Hugging Face model plus a GPU to run
 * at a sensible speed. Since the transcript is already going to Gemini,
 * this infers speaker turns from the conversation itself: who is being
 * addressed by name, who answers a question, where the topic hands
 * over. It is a text-level approximation of diarization, not acoustic
 * separation -- see docs/DECISIONS.md.
 */

const SYSTEM_INSTRUCTION = `
You label who is speaking in a meeting transcript.

You receive numbered segments in chronological order. Return exactly
one speaker label per segment number.

Rules:
- Infer speaker changes from conversational cues: greetings,
  questions and their answers, names used in address, handovers
  ("over to you, Priya"), and shifts in topic or point of view.
- If a participant's real name is stated in the conversation, use that
  name. Otherwise use "Speaker 1", "Speaker 2", and so on.
- Reuse the same label every time the same person speaks. Consistency
  across the whole transcript matters more than the label itself.
- Consecutive segments are usually the same speaker. Only change
  speaker when there is a cue suggesting it.
- Never edit, merge, split, or reorder the segments. Labels only.
`.trim();

/**
 * Segments per Gemini call.
 *
 * Small enough that a long meeting does not blow the output limit
 * (each entry costs tokens), large enough that the model still sees
 * enough conversation to tell speakers apart.
 */
const BATCH_SIZE = 120;

/**
 * Segments of prior context replayed with each batch after the first,
 * so speaker labels stay consistent across batch boundaries.
 */
const CONTEXT_SIZE = 8;

const parseLabels = (
  raw: string,
  expected: number
): Map<number, string> => {
  const parsed = parseJsonResponse(raw, "speaker list");

  const labels = new Map<number, string>();

  if (!Array.isArray(parsed.speakers)) {
    return labels;
  }

  for (const entry of parsed.speakers) {
    if (typeof entry !== "object" || entry === null) continue;

    const item = entry as Record<string, unknown>;

    const index = Number(item.index);
    const speaker =
      typeof item.speaker === "string" ? item.speaker.trim() : "";

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected ||
      !speaker
    ) {
      continue;
    }

    // Guard against a runaway label; these are shown as chips.
    labels.set(index, speaker.slice(0, 60));
  }

  return labels;
};

/** Labels one batch, given some already-labelled context before it. */
const labelBatch = async (
  batch: RawSegment[],
  context: DiarizedSegment[]
): Promise<Map<number, string>> => {
  const contextBlock = context.length
    ? `Earlier in this meeting, already labelled:\n${context
        .map((s) => `${s.speaker}: ${s.text}`)
        .join("\n")}\n\nContinue using these same labels.\n\n`
    : "";

  const numbered = batch
    .map(
      (segment, index) =>
        `${index}. [${formatTimestamp(segment.startMs)}] ${segment.text}`
    )
    .join("\n");

  const response = await withRetry(() =>
    getClient().models.generateContent({
      model: env.geminiModel,

      contents:
        `${contextBlock}Label these ${batch.length} segments ` +
        `(indices 0 to ${batch.length - 1}):\n${numbered}`,

      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: DIARIZATION_SCHEMA,
      },
    })
  );

  return parseLabels(response.text ?? "", batch.length);
};

/**
 * Assigns a speaker to every segment.
 *
 * Degrades rather than fails: any segment the model does not label
 * inherits the previous segment's speaker, and if the call fails
 * outright every segment falls back to a single speaker. A transcript
 * with imperfect attribution is far more useful than none.
 */
export async function diarizeSegments(
  segments: RawSegment[]
): Promise<DiarizedSegment[]> {
  if (segments.length === 0) return [];

  const labelled: DiarizedSegment[] = [];

  const fallbackFrom = (index: number): string =>
    labelled[index - 1]?.speaker ?? "Speaker 1";

  try {
    for (let start = 0; start < segments.length; start += BATCH_SIZE) {
      const batch = segments.slice(start, start + BATCH_SIZE);

      const labels = await labelBatch(
        batch,
        labelled.slice(-CONTEXT_SIZE)
      );

      batch.forEach((segment, indexInBatch) => {
        labelled.push({
          ...segment,
          speaker:
            labels.get(indexInBatch) ??
            fallbackFrom(start + indexInBatch),
        });
      });
    }

    const distinct = new Set(labelled.map((s) => s.speaker)).size;

    log.info("Diarization complete", {
      segments: labelled.length,
      speakers: distinct,
    });

    return labelled;
  } catch (error) {
    // Attribution is an enhancement; losing it must not cost the user
    // their transcript.
    log.warn("Diarization failed, falling back to a single speaker", {
      reason: toGeminiError(error, "diarization failed").message,
      segments: segments.length,
    });

    return segments.map((segment) => ({
      ...segment,
      speaker: "Speaker 1",
    }));
  }
}
