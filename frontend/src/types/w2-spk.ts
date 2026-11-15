import type { Segment } from "./meeting";

/** Speakers of one meeting (track w2-spk; backend routes/w2-spk.routes.ts). */

/**
 * A transcript segment as GET /meetings/:id/segments returns it. The
 * extra fields are stored on every row (null for older ones); typed
 * here so types/meeting.ts stays untouched.
 */
export interface SpeakerSegment extends Segment {
  /** SpeakerProfile id, once speakers are resolved. */
  speakerId?: string | null;
  /** "mic" (you) | "remote" (everyone else) | null (mono). */
  channel?: string | null;
  /** CLEAN-pass label; anything but "substantive" is noise. Null = unlabelled. */
  noiseLabel?: string | null;
}

export type NameSignal = "self_intro" | "roster" | "addressed";

export interface SpeakerView {
  /** SpeakerProfile id, or "label:<speaker>" for segments without one. */
  key: string;
  speakerId: string | null;
  label: string;
  name: string;
  isMe: boolean;
  source: string;
  segmentCount: number;
  /** A name with one signal: offered, never applied automatically. */
  suggestion: { name: string; confidence: number; signals: NameSignal[] } | null;
}

export interface RenameResult {
  key: string;
  speakerId: string;
  name: string;
  segments: number;
}
