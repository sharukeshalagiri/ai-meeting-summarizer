import type {
  Evidence,
  NoiseLabel,
  SummaryBody,
  SummaryMode,
  SummaryV2,
} from "../types/summary";

/**
 * Demo mode (track w5-demo): three synthetic, fully processed meetings
 * that a visitor can open without signing up. Nothing here is real: the
 * transcripts are the repo's synthetic fixtures (fixtures/transcripts),
 * and the summaries are written by hand in the pipeline's v2 shape.
 *
 * This module is type-only so the screenshot runner (e2e/screenshots)
 * can import the builder without loading env, Prisma or Gemini.
 */

/** The demo account. example.com is reserved, so it can never be real. */
export const DEMO_EMAIL = "demo@example.com";
export const DEMO_NAME = "Demo visitor";

export type DemoKey = "lecture" | "interview" | "project";

/** One line of a demo transcript: who said it and what. */
export type DemoLine = readonly [speaker: string, text: string];

/**
 * A hand-written demo meeting. Evidence is written as segment idx
 * numbers (as the model returns them); the builder turns each into an
 * `Evidence` with the segment's speaker and startMs, the same way the
 * pipeline's VERIFY step does, so a chip can never point at a segment
 * that does not exist.
 */
export interface DemoMeetingSpec {
  key: DemoKey;
  title: string;
  description: string;
  mode: SummaryMode;
  /** Days before the seed time the meeting "happened" (list order). */
  daysAgo: number;
  /** The recording user's name: their lines are the mic channel. */
  me: string;
  /** Segment idx = position in this list (uploads are dense, 0..n-1). */
  lines: DemoLine[];
  /** CLEAN-pass labels; every idx not listed is "substantive". */
  noise: Partial<Record<number, NoiseLabel>>;
  summary: SummaryBody<number>;
  /** Action item status overrides by task index (default PENDING). */
  taskStatus?: Partial<Record<number, "PENDING" | "COMPLETED">>;
}

/** Start and end of one segment in the generated audio. */
export interface SegmentTiming {
  startMs: number;
  endMs: number;
}

export interface DemoSegment {
  idx: number;
  speaker: string;
  /** SpeakerProfile.label: "mic" for the user, "Speaker N" otherwise. */
  speakerLabel: string;
  text: string;
  startMs: number;
  endMs: number;
  channel: "mic" | "remote";
  noiseLabel: NoiseLabel;
}

export interface DemoSpeaker {
  label: string;
  displayName: string;
  isMe: boolean;
}

export interface DemoActionItem {
  task: string;
  owner: string | null;
  assignedBy: string | null;
  dueSpoken: string | null;
  dueDate: string | null;
  priority: string;
  status: "PENDING" | "COMPLETED";
  confidence: number;
  needsReview: boolean;
  evidence: Evidence[];
}

/** Everything the seed writes for one meeting, before ids exist. */
export interface DemoMeeting {
  key: DemoKey;
  title: string;
  description: string;
  mode: SummaryMode;
  createdAt: Date;
  durationSec: number;
  segments: DemoSegment[];
  speakers: DemoSpeaker[];
  /** Transcript.content: "[mm:ss] Speaker: text" lines. */
  transcriptText: string;
  summary: SummaryV2;
  actionItems: DemoActionItem[];
}
