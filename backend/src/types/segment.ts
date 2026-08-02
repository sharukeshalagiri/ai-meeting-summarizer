import { Type } from "@google/genai";

/** A timestamped slice of audio, before speakers are attributed. */
export interface RawSegment {
  text: string;
  startMs: number;
  endMs: number;
}

/** A segment once a speaker label has been assigned. */
export interface DiarizedSegment extends RawSegment {
  speaker: string;
}

/**
 * Asks Gemini for one speaker label per segment.
 *
 * The model returns labels only, keyed by index, rather than echoing
 * the text back: it keeps the response small on long meetings and
 * removes any chance of the transcript being rewritten in the process.
 */
export const DIARIZATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    speakers: {
      type: Type.ARRAY,
      description:
        "One entry per numbered segment, in the same order as the " +
        "input. Must have exactly as many entries as there are " +
        "segments.",
      items: {
        type: Type.OBJECT,
        properties: {
          index: {
            type: Type.INTEGER,
            description: "The segment number being labelled.",
          },
          speaker: {
            type: Type.STRING,
            description:
              "The speaker's name if it can be inferred from the " +
              'conversation, otherwise "Speaker 1", "Speaker 2", ' +
              "and so on. Use the same label every time the same " +
              "person speaks.",
          },
        },
        required: ["index", "speaker"],
      },
    },
  },
  required: ["speakers"],
};

/** Formats a millisecond offset as mm:ss or h:mm:ss. */
export const formatTimestamp = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (value: number) => String(value).padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

/**
 * Renders segments as a speaker-attributed script.
 *
 * This is what the summarizer reads, so it can attribute decisions and
 * action items to the person who actually spoke them.
 */
export const toSpeakerTranscript = (
  segments: DiarizedSegment[]
): string =>
  segments
    .map(
      (segment) =>
        `[${formatTimestamp(segment.startMs)}] ${segment.speaker}: ` +
        segment.text
    )
    .join("\n");
