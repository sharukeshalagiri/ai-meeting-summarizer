import { Type } from "@google/genai";

/** A transcript moment backing part of an answer. */
export interface Citation {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  speaker: string;
  text: string;
  startMs: number;
  /** Human-readable form of startMs, e.g. "12:34". */
  timestamp: string;
}

export interface ChatAnswer {
  answer: string;
  citations: Citation[];
}

/**
 * The model returns excerpt numbers rather than citation objects: it
 * only ever sees numbered excerpts, so asking it to echo back segment
 * ids would invite hallucinated ones. The numbers are resolved against
 * the retrieved set server-side.
 */
export const CHAT_ANSWER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description:
        "The answer, drawn only from the excerpts provided.",
    },
    citations: {
      type: Type.ARRAY,
      description:
        "Numbers of the excerpts the answer rests on. Empty if the " +
        "excerpts do not answer the question.",
      items: { type: Type.INTEGER },
    },
  },
  required: ["answer", "citations"],
};
