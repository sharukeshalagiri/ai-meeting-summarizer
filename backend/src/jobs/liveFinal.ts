import type { DiarizedSegment, RawSegment } from "../types/segment";

/**
 * Speakers for the live final pass, carried over from the live draft.
 *
 * The final pass re-transcribes the assembled recording, so its segments
 * are cut differently from the draft's. The user has already seen (and
 * may have renamed) the draft's speakers: a rename is a SpeakerProfile
 * with source MANUAL, the segments' `speaker` text, and a SPEAKER
 * Correction. Re-diarizing from scratch could hand "Speaker 2" to a
 * different voice and silently move a rename onto the wrong person.
 *
 * So each final segment takes the speaker (label text and speakerId) of
 * the draft segment it overlaps most in time, on the same channel. The
 * assembled recording keeps the draft's timeline exactly (see
 * assemble.ts), so the overlap is meaningful. Only segments with no
 * draft counterpart (audio from a chunk that failed live, for example)
 * go to the diarizer. Corrections are never touched: they stay as
 * history and as the rename map applied at read time.
 */

export interface DraftSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  channel?: string | null;
  speakerId?: string | null;
}

export type CarriedSegment = DiarizedSegment & { speakerId?: string };

/** A final segment needs this share of its length covered to inherit. */
export const MIN_OVERLAP_SHARE = 0.3;

const channelsMatch = (a?: string | null, b?: string | null) =>
  a == null || b == null || a === b;

const overlapMs = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);

/**
 * Speaker of each final segment from the draft (pure). `uncovered` lists
 * the positions with no draft speaker; their `speaker` is "" until the
 * caller diarizes them.
 */
export const carrySpeakers = (
  finals: RawSegment[],
  draft: DraftSegment[],
  minShare = MIN_OVERLAP_SHARE
): { segments: CarriedSegment[]; uncovered: number[] } => {
  const uncovered: number[] = [];

  const segments = finals.map((segment, position) => {
    const length = Math.max(1, segment.endMs - segment.startMs);
    let best: DraftSegment | null = null;
    let bestOverlap = 0;

    for (const candidate of draft) {
      if (!channelsMatch(segment.channel, candidate.channel)) continue;

      // A zero-length segment counts as 1 ms at its start.
      const overlap =
        segment.endMs > segment.startMs
          ? overlapMs(segment, candidate)
          : segment.startMs >= candidate.startMs && segment.startMs < candidate.endMs
            ? 1
            : 0;

      if (overlap > bestOverlap) {
        best = candidate;
        bestOverlap = overlap;
      }
    }

    if (!best || bestOverlap < minShare * length) {
      uncovered.push(position);
      return { ...segment, speaker: "" };
    }

    return {
      ...segment,
      speaker: best.speaker,
      ...(best.speakerId ? { speakerId: best.speakerId } : {}),
    };
  });

  return { segments, uncovered };
};
