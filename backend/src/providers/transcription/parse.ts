import type {
  TranscribedSegment,
  WordTiming,
} from "../../types/providers";

/**
 * Whisper occasionally emits filler ("Thank you.", "Bye.") over
 * silence. The ai-service guards already drop most of it; this is the
 * backend's last line, for segments the model is fairly sure contain no
 * speech.
 */
export const NO_SPEECH_THRESHOLD = 0.75;

const asChannel = (value: unknown): "mic" | "remote" | null =>
  value === "mic" || value === "remote" ? value : null;

/**
 * Validates the ai-service word list ({ w, startMs, endMs, p }). Bad
 * entries are dropped rather than failing the whole segment.
 */
export const parseWords = (value: unknown): WordTiming[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;
    const word = typeof item.w === "string" ? item.w.trim() : "";
    const startMs = Number(item.startMs);
    const endMs = Number(item.endMs);

    if (!word || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return [];
    }

    const p = Number(item.p);
    const start = Math.max(0, Math.round(startMs));

    return [
      {
        word,
        startMs: start,
        endMs: Math.max(start, Math.round(endMs)),
        ...(Number.isFinite(p) && item.p !== null
          ? { probability: Math.min(1, Math.max(0, p)) }
          : {}),
      },
    ];
  });
};

/**
 * Validates the segment list returned by the ai-service into the
 * provider contract. Never trusts the upstream shape: anything malformed
 * is dropped.
 */
export const parseLocalSegments = (value: unknown): TranscribedSegment[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    const text = typeof item.text === "string" ? item.text.trim() : "";
    const startMs = Number(item.startMs);
    const endMs = Number(item.endMs);

    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return [];
    }

    const noSpeechProb = Number(item.noSpeechProb);

    if (
      Number.isFinite(noSpeechProb) &&
      noSpeechProb > NO_SPEECH_THRESHOLD
    ) {
      return [];
    }

    const words = parseWords(item.words);
    const channel = asChannel(item.channel);
    const start = Math.max(0, Math.round(startMs));

    return [
      {
        text,
        startMs: start,
        // Guard against an inverted span, which would break duration
        // maths downstream.
        endMs: Math.max(Math.round(startMs), Math.round(endMs)),
        ...(channel ? { channel } : {}),
        ...(words.length ? { words } : {}),
        ...(Number.isFinite(noSpeechProb) ? { noSpeechProb } : {}),
      },
    ];
  });
};
