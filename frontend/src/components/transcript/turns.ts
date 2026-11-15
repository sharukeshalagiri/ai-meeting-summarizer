import type { SpeakerSegment } from "../../types/w2-spk";

/**
 * Pure transcript shaping for TranscriptView (no React, unit-tested).
 *
 * Consecutive segments from one speaker merge into a turn: raw segments
 * are as short as a clause, and one row each reads as a wall of
 * fragments. Speakers are compared by key (SpeakerProfile id, else the
 * label), so a rename never splits or merges turns by accident.
 */

export const LABEL_KEY_PREFIX = "label:";

/** The speaker key the backend uses (speakers.service.ts). */
export const speakerKey = (segment: SpeakerSegment): string =>
  segment.speakerId ?? `${LABEL_KEY_PREFIX}${segment.speaker}`;

/**
 * Noise = labelled by the summary's CLEAN pass as anything but
 * substantive (small talk, logistics, filler, off topic). Unlabelled
 * segments (null) are not noise: they have not been classified yet.
 */
export const isNoise = (segment: SpeakerSegment): boolean =>
  !!segment.noiseLabel && segment.noiseLabel !== "substantive";

export interface Turn {
  key: string;
  speaker: string;
  isMe: boolean;
  startMs: number;
  endMs: number;
  timestamp: string;
  /** Every segment of the turn, hidden or not (one seg-<idx> each). */
  parts: SpeakerSegment[];
  /** Parts hidden by the noise filter. */
  hiddenIdx: Set<number>;
}

export const buildTurns = (
  segments: SpeakerSegment[],
  options: {
    /** Name overrides by speaker key (renames made on this page). */
    names?: ReadonlyMap<string, string>;
    hideNoise?: boolean;
    /** Segments revealed despite the filter (e.g. a jump target). */
    revealed?: ReadonlySet<number>;
  } = {}
): Turn[] => {
  const turns: Turn[] = [];

  for (const segment of segments) {
    const key = speakerKey(segment);
    const last = turns[turns.length - 1];
    const hidden =
      !!options.hideNoise && isNoise(segment) && !options.revealed?.has(segment.idx);

    if (last && last.key === key) {
      last.endMs = segment.endMs;
      last.parts.push(segment);
      if (hidden) last.hiddenIdx.add(segment.idx);
      continue;
    }

    turns.push({
      key,
      speaker: options.names?.get(key) ?? segment.speaker,
      isMe: segment.channel === "mic",
      startMs: segment.startMs,
      endMs: segment.endMs,
      timestamp: segment.timestamp,
      parts: [segment],
      hiddenIdx: hidden ? new Set([segment.idx]) : new Set(),
    });
  }

  return turns;
};

/** True when every part of the turn is hidden. */
export const isHiddenTurn = (turn: Turn): boolean =>
  turn.hiddenIdx.size === turn.parts.length;

/**
 * Turns matching a search. Hidden parts are searched too: a match
 * reveals nothing by itself, but the turn stays listed (its fold shows).
 */
export const filterTurns = (turns: Turn[], query: string): Turn[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return turns;

  return turns.filter(
    (turn) =>
      turn.speaker.toLowerCase().includes(needle) ||
      turn.parts.some((part) => part.text.toLowerCase().includes(needle))
  );
};

/**
 * Runs of hidden parts inside a turn, so each run renders as one fold
 * ("2 lines hidden") in place, keeping reading order.
 */
export const partRuns = (
  turn: Turn
): { hidden: boolean; parts: SpeakerSegment[] }[] => {
  const runs: { hidden: boolean; parts: SpeakerSegment[] }[] = [];
  for (const part of turn.parts) {
    const hidden = turn.hiddenIdx.has(part.idx);
    const last = runs[runs.length - 1];
    if (last && last.hidden === hidden) last.parts.push(part);
    else runs.push({ hidden, parts: [part] });
  }
  return runs;
};

const NOISE_NAMES: Record<string, string> = {
  small_talk: "small talk",
  logistics: "logistics",
  filler: "filler",
  off_topic: "off topic",
};

/** "2 lines of small talk", "3 lines hidden" for mixed labels. */
export const foldLabel = (parts: SpeakerSegment[]): string => {
  const labels = new Set(parts.map((p) => p.noiseLabel ?? ""));
  const lines = `${parts.length} line${parts.length === 1 ? "" : "s"}`;
  if (labels.size === 1) {
    const name = NOISE_NAMES[[...labels][0]];
    if (name) return `${lines} of ${name}`;
  }
  return `${lines} hidden`;
};
