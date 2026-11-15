import { env } from "../lib/env";
import { toGeminiError } from "../lib/gemini";
import { logger } from "../lib/logger";
import type { DiarizedSegment, RawSegment } from "../types/segment";
import {
  attributeChunk,
  type AttributedSegment,
  type SpeakerContext,
} from "./speakers/attribute";
import { labelWithGemini } from "./speakers/textLabels";

const log = logger.child({ module: "diarization.service" });

/**
 * Speaker attribution: who said each segment.
 *
 * - Segments on the "mic" channel are the user, always (left channel of
 *   the capture contract). The ASR already dropped mic echo of remote
 *   speech, so no model is needed for them.
 * - With a meeting context (live capture), the rest is diarized by voice
 *   (ai-service speaker embeddings) and matched to the meeting's
 *   SpeakerProfiles, so labels stay stable across chunks; see
 *   services/speakers/attribute.ts.
 * - Without one (uploads, evaluation), the rest is labelled by Gemini
 *   from conversational cues, the original text-level approximation
 *   (docs/DECISIONS.md).
 */

export type { AttributedSegment, SpeakerContext };

/** Text-only attribution for callers with no meeting context. */
const labelByText = async (
  segments: RawSegment[]
): Promise<DiarizedSegment[]> => {
  const others = segments.filter((s) => s.channel !== "mic");
  let labels: string[] = [];

  if (others.length) {
    try {
      labels = await labelWithGemini(others);

      log.info("Diarization complete", {
        segments: segments.length,
        speakers: new Set(labels).size,
      });
    } catch (error) {
      // Attribution is an enhancement; losing it must not cost the user
      // their transcript.
      log.warn("Diarization failed, falling back to a single speaker", {
        reason: toGeminiError(error, "diarization failed").message,
        segments: others.length,
      });
      labels = others.map(() => "Speaker 1");
    }
  }

  let next = 0;
  return segments.map((segment) => ({
    ...segment,
    speaker: segment.channel === "mic" ? env.meDisplayName : labels[next++],
  }));
};

/**
 * Assigns a speaker to every segment, in order, same length.
 *
 * `context` is optional so existing callers (uploads, w2-eval's DER run)
 * keep `diarizeSegments(segments)`. With it, segments also carry the
 * resolved `speakerId`; store it with `linkSegmentSpeakers` once the
 * segments are written.
 *
 * Degrades rather than fails: a failed provider falls back to text
 * diarization, then to continuity, then to a single speaker.
 */
export async function diarizeSegments(
  segments: RawSegment[],
  context?: SpeakerContext
): Promise<AttributedSegment[]> {
  if (segments.length === 0) return [];

  if (context?.meetingId) {
    try {
      return await attributeChunk(segments, context);
    } catch (error) {
      // Profiles are stored in the database; if that fails, still keep
      // the transcript with text labels.
      log.error("Speaker attribution failed; using text labels", error, {
        meetingId: context.meetingId,
      });
    }
  }

  return labelByText(segments);
}
