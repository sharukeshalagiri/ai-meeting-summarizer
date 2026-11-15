import { diarizeSegments } from "../../backend/src/services/diarization.service";
import type { HypSegment } from "./audio";

/**
 * The one place the evaluation touches diarization: the exported
 * `diarizeSegments`. Main's version infers speakers from text with
 * Gemini (metered and capped like every other call); w2-spk keeps the
 * export compatible, so its version is picked up here after it merges
 * with no change to the harness.
 */
export const diarize = async (segments: HypSegment[]): Promise<HypSegment[]> => {
  const input = segments.map((segment) => ({
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    ...(segment.channel === "mic" || segment.channel === "remote" ? { channel: segment.channel as "mic" | "remote" } : {}),
  }));
  const labelled = await diarizeSegments(input);
  return labelled.map((segment) => ({ ...segment, speaker: segment.speaker }));
};
