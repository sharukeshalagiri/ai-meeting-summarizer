import { normalizeWords, wordErrorRate } from "../../scripts/benchmark-transcription.mjs";
import type { AudioReference } from "./types";

/**
 * Transcription and attribution metrics for audio cases (AMI, own
 * recordings): WER, DER and "my lines labelled as me". Pure functions
 * over timed words and segments; no audio is touched here.
 */

export interface HypSegment {
  text: string;
  startMs: number;
  endMs: number;
  /** "mic" (left, the user) | "remote" | null. */
  channel?: string | null;
  /** Diarized speaker label, when diarization ran. */
  speaker?: string | null;
}

/** Filler words both sides drop: annotators write them, Whisper mostly does not. */
const FILLERS = new Set(["uh", "um", "hmm", "mm", "mm-hmm", "uh-huh", "huh", "ah", "eh", "oh", "er", "erm"]);

export const werText = (text: string): string =>
  normalizeWords(text)
    .filter((word: string) => !FILLERS.has(word))
    .join(" ");

export interface WerResult {
  wer: number;
  refWords: number;
  /** wer * refWords, so cases can be pooled (micro average). */
  errors: number;
}

export const computeWer = (reference: AudioReference, hypothesis: HypSegment[]): WerResult => {
  const ref = werText(reference.words.map((w) => w.text).join(" "));
  const hyp = werText(
    [...hypothesis]
      .sort((a, b) => a.startMs - b.startMs)
      .map((s) => s.text)
      .join(" ")
  );
  const refWords = ref ? ref.split(" ").length : 0;
  const wer = wordErrorRate(ref, hyp);
  return { wer, refWords, errors: Math.round(wer * refWords) };
};

export interface Turn {
  speaker: string;
  startMs: number;
  endMs: number;
}

/** Consecutive words of one speaker, with gaps under `maxGapMs`, form one turn. */
export const wordsToTurns = (words: AudioReference["words"], maxGapMs = 500): Turn[] => {
  const bySpeaker = new Map<string, AudioReference["words"]>();
  for (const word of words) {
    if (!bySpeaker.has(word.speaker)) bySpeaker.set(word.speaker, []);
    bySpeaker.get(word.speaker)!.push(word);
  }

  const turns: Turn[] = [];
  for (const [speaker, list] of bySpeaker) {
    list.sort((a, b) => a.startMs - b.startMs);
    let current: Turn | null = null;
    for (const word of list) {
      if (current && word.startMs - current.endMs < maxGapMs) {
        current.endMs = Math.max(current.endMs, word.endMs);
      } else {
        if (current) turns.push(current);
        current = { speaker, startMs: word.startMs, endMs: word.endMs };
      }
    }
    if (current) turns.push(current);
  }

  return turns.sort((a, b) => a.startMs - b.startMs);
};

export interface DerResult {
  der: number;
  scoredMs: number;
  missedMs: number;
  falseAlarmMs: number;
  confusionMs: number;
  /** hyp label -> ref speaker chosen by the optimal mapping. */
  mapping: Record<string, string>;
}

const FRAME_MS = 10;

/**
 * Diarization error rate, NIST style, on 10 ms frames:
 * (missed + false alarm + confusion) / reference speech time. Overlapping
 * speech is scored. Frames within `collarMs` of a reference turn
 * boundary are not scored. Hypothesis labels are mapped one-to-one onto
 * reference speakers to maximise overlap (exhaustive search, greedy past
 * eight labels).
 */
export const diarizationErrorRate = (ref: Turn[], hyp: Turn[], collarMs = 250): DerResult => {
  const end = Math.max(0, ...ref.map((t) => t.endMs), ...hyp.map((t) => t.endMs));
  const frames = Math.ceil(end / FRAME_MS);
  const refSpeakers = [...new Set(ref.map((t) => t.speaker))];
  const hypSpeakers = [...new Set(hyp.map((t) => t.speaker))];

  const fill = (turns: Turn[], speakers: string[]) => {
    const masks = new Uint32Array(frames);
    for (const turn of turns) {
      const bit = 1 << speakers.indexOf(turn.speaker);
      for (let f = Math.floor(turn.startMs / FRAME_MS); f < Math.ceil(turn.endMs / FRAME_MS) && f < frames; f++) {
        masks[f] |= bit;
      }
    }
    return masks;
  };

  const refMask = fill(ref, refSpeakers);
  const hypMask = fill(hyp, hypSpeakers);

  const scored = new Uint8Array(frames).fill(1);
  const collar = Math.round(collarMs / FRAME_MS);
  for (const turn of ref) {
    for (const edge of [turn.startMs, turn.endMs]) {
      const at = Math.round(edge / FRAME_MS);
      for (let f = Math.max(0, at - collar); f < Math.min(frames, at + collar); f++) scored[f] = 0;
    }
  }

  // overlap[h][r] in frames.
  const overlap = hypSpeakers.map(() => refSpeakers.map(() => 0));
  for (let f = 0; f < frames; f++) {
    if (!scored[f] || !refMask[f] || !hypMask[f]) continue;
    for (let h = 0; h < hypSpeakers.length; h++) {
      if (!(hypMask[f] & (1 << h))) continue;
      for (let r = 0; r < refSpeakers.length; r++) if (refMask[f] & (1 << r)) overlap[h][r]++;
    }
  }

  const assign = bestMapping(overlap, refSpeakers.length);

  let scoredRef = 0;
  let missed = 0;
  let falseAlarm = 0;
  let confusion = 0;
  const popcount = (x: number) => {
    let n = 0;
    while (x) {
      n += x & 1;
      x >>>= 1;
    }
    return n;
  };

  for (let f = 0; f < frames; f++) {
    if (!scored[f]) continue;
    const nRef = popcount(refMask[f]);
    const nHyp = popcount(hypMask[f]);
    let mappedHit = 0;
    for (let h = 0; h < hypSpeakers.length; h++) {
      const r = assign[h];
      if (r >= 0 && hypMask[f] & (1 << h) && refMask[f] & (1 << r)) mappedHit++;
    }
    scoredRef += nRef;
    missed += Math.max(0, nRef - nHyp);
    falseAlarm += Math.max(0, nHyp - nRef);
    confusion += Math.min(nRef, nHyp) - mappedHit;
  }

  const mapping: Record<string, string> = {};
  assign.forEach((r, h) => {
    if (r >= 0) mapping[hypSpeakers[h]] = refSpeakers[r];
  });

  return {
    der: scoredRef ? (missed + falseAlarm + confusion) / scoredRef : 0,
    scoredMs: scoredRef * FRAME_MS,
    missedMs: missed * FRAME_MS,
    falseAlarmMs: falseAlarm * FRAME_MS,
    confusionMs: confusion * FRAME_MS,
    mapping,
  };
};

/** hyp index -> ref index (or -1), maximising total overlap, one-to-one. */
const bestMapping = (overlap: number[][], refCount: number): number[] => {
  const hypCount = overlap.length;

  if (hypCount > 8) {
    const assign = new Array(hypCount).fill(-1);
    const takenRef = new Set<number>();
    const cells = overlap
      .flatMap((row, h) => row.map((value, r) => ({ h, r, value })))
      .sort((a, b) => b.value - a.value);
    for (const cell of cells) {
      if (cell.value <= 0 || assign[cell.h] >= 0 || takenRef.has(cell.r)) continue;
      assign[cell.h] = cell.r;
      takenRef.add(cell.r);
    }
    return assign;
  }

  let best = -1;
  let bestAssign: number[] = new Array(hypCount).fill(-1);
  const current: number[] = [];
  const recurse = (h: number, used: number, total: number) => {
    if (h === hypCount) {
      if (total > best) {
        best = total;
        bestAssign = [...current];
      }
      return;
    }
    current[h] = -1;
    recurse(h + 1, used, total);
    for (let r = 0; r < refCount; r++) {
      if (used & (1 << r)) continue;
      current[h] = r;
      recurse(h + 1, used | (1 << r), total + overlap[h][r]);
    }
  };
  recurse(0, 0, 0);
  return bestAssign;
};

/** Reference turns collapsed to two speakers: the user and everyone else. */
export const meVsOthers = (turns: Turn[], me: string): Turn[] =>
  turns.map((t) => ({ ...t, speaker: t.speaker === me ? "me" : "others" }));

/** Hypothesis turns from the channel: mic = me, remote = others. */
export const channelTurns = (segments: HypSegment[]): Turn[] =>
  segments
    .filter((s) => s.channel === "mic" || s.channel === "remote")
    .map((s) => ({ speaker: s.channel === "mic" ? "me" : "others", startMs: s.startMs, endMs: s.endMs }));

export const speakerTurns = (segments: HypSegment[]): Turn[] =>
  segments
    .filter((s) => s.speaker)
    .map((s) => ({ speaker: s.speaker as string, startMs: s.startMs, endMs: s.endMs }));

export interface MeResult {
  /** Share of the user's reference words that fall inside a "mic" segment. */
  recall: number;
  /** Share of "mic" segment time with reference speech that is the user's. */
  precision: number;
  meWords: number;
}

const overlapMs = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/**
 * "My lines labelled as me". A word counts when its midpoint lies inside
 * a hypothesis segment from the mic channel.
 */
export const meAttribution = (reference: AudioReference, hypothesis: HypSegment[]): MeResult => {
  const mic = hypothesis.filter((s) => s.channel === "mic");
  const meWords = reference.words.filter((w) => w.speaker === reference.me);
  const covered = meWords.filter((w) => {
    const mid = (w.startMs + w.endMs) / 2;
    return mic.some((s) => s.startMs <= mid && mid <= s.endMs);
  }).length;

  let meTime = 0;
  let speechTime = 0;
  for (const segment of mic) {
    for (const word of reference.words) {
      const ms = overlapMs(segment, word);
      speechTime += ms;
      if (word.speaker === reference.me) meTime += ms;
    }
  }

  return {
    recall: meWords.length ? covered / meWords.length : 0,
    precision: speechTime ? meTime / speechTime : 0,
    meWords: meWords.length,
  };
};
