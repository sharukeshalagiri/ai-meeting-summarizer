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

/** A segment of the final transcript, by its new idx. */
export interface FinalSegment {
  idx: number;
  startMs: number;
  endMs: number;
}

/**
 * The final segment for a moment: the one that contains it, else the
 * nearest one (pure). Null only when there are no segments.
 */
export const segmentAt = (segments: FinalSegment[], atMs: number): FinalSegment | null => {
  let best: FinalSegment | null = null;
  let bestDistance = Infinity;

  for (const segment of segments) {
    if (atMs >= segment.startMs && atMs < segment.endMs) return segment;
    const distance = atMs < segment.startMs ? segment.startMs - atMs : atMs - segment.endMs;
    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }

  return best;
};

/**
 * Re-points stored evidence (`[{ idx, startMs?, ... }]`) from draft idx
 * values to the final transcript's idx (pure), so jumpToSegment on a
 * surviving action item still lands where it was said. Each entry's
 * moment is its own `startMs`, else the draft segment's start (captured
 * before the draft was replaced). The entry gets the final segment that
 * covers that moment (or the nearest) and keeps `startMs`, so a later
 * pass (late chunks) can remap it again. Entries with no known moment
 * are left as they are. Returns null when nothing changed.
 */
export const remapEvidence = (
  evidence: unknown,
  draftStartByIdx: ReadonlyMap<number, number>,
  finals: FinalSegment[]
): Record<string, unknown>[] | null => {
  if (!Array.isArray(evidence) || finals.length === 0) return null;

  let changed = false;

  const remapped = evidence.map((raw: unknown) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.idx !== "number") return entry;

    const atMs =
      typeof entry.startMs === "number" ? entry.startMs : draftStartByIdx.get(entry.idx);
    if (atMs === undefined) return entry;

    const target = segmentAt(finals, atMs);
    if (!target) return entry;

    if (target.idx !== entry.idx || entry.startMs !== atMs) changed = true;
    return { ...entry, idx: target.idx, startMs: atMs };
  });

  return changed ? (remapped as Record<string, unknown>[]) : null;
};
