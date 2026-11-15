import { env } from "../../lib/env";
import {
  getClient,
  parseJsonResponse,
  withRetry,
} from "../../lib/gemini";
import { DIARIZATION_SCHEMA, formatTimestamp } from "../../types/segment";

/**
 * Text-based speaker labels from Gemini (the original diarization,
 * docs/DECISIONS.md "Diarization is inferred from the transcript").
 *
 * Now the fallback: used when voice diarization is unavailable (the
 * ai-service is down or has no model) and for callers with no audio.
 * Infers turns from conversational cues: names used in address,
 * question-and-answer pairs, handovers.
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
- If known speaker labels are listed, reuse them exactly for the same
  people; never rename a known speaker.
- Consecutive segments are usually the same speaker. Only change
  speaker when there is a cue suggesting it.
- Never edit, merge, split, or reorder the segments. Labels only.
`.trim();

/**
 * Segments per Gemini call: small enough that a long meeting does not
 * blow the output limit, large enough to tell speakers apart.
 */
export const BATCH_SIZE = 120;

/**
 * Segments of already-labelled context replayed with each batch (and,
 * live, from the previous chunk), so labels stay consistent across
 * batch and chunk boundaries.
 */
export const CONTEXT_SIZE = 8;

export interface LabelledLine {
  speaker: string;
  text: string;
}

export const parseLabels = (
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

const labelBatch = async (
  batch: { text: string; startMs: number }[],
  context: LabelledLine[],
  knownLabels: string[]
): Promise<Map<number, string>> => {
  const known = knownLabels.length
    ? `Known speakers so far: ${knownLabels.join(", ")}.\n\n`
    : "";

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
        `${known}${contextBlock}Label these ${batch.length} segments ` +
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
 * One label per segment. A segment the model leaves unlabelled
 * inherits the previous label (or the last context label, or
 * "Speaker 1"). Throws if Gemini fails; callers decide how to degrade.
 */
export const labelWithGemini = async (
  segments: { text: string; startMs: number }[],
  context: LabelledLine[] = [],
  knownLabels: string[] = []
): Promise<string[]> => {
  const labels: string[] = [];
  const history: LabelledLine[] = [...context];

  for (let start = 0; start < segments.length; start += BATCH_SIZE) {
    const batch = segments.slice(start, start + BATCH_SIZE);

    const found = await labelBatch(
      batch,
      history.slice(-CONTEXT_SIZE),
      knownLabels
    );

    batch.forEach((segment, i) => {
      const speaker =
        found.get(i) ??
        labels[labels.length - 1] ??
        history[history.length - 1]?.speaker ??
        "Speaker 1";
      labels.push(speaker);
      history.push({ speaker, text: segment.text });
    });
  }

  return labels;
};
