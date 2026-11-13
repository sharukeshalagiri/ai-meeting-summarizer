/**
 * Capture contract values shared by every recorder (extension, desktop
 * app, web page, bot). docs/CAPTURE_CONTRACT.md is the human-readable
 * version; keep the two in sync.
 */

/** Contract platform names mapped to the values already stored. */
export const PLATFORM_ALIASES: Record<string, string> = {
  MEET: "GOOGLE_MEET",
  GOOGLE_MEET: "GOOGLE_MEET",
  ZOOM: "ZOOM",
  TEAMS: "MICROSOFT_TEAMS",
  MICROSOFT_TEAMS: "MICROSOFT_TEAMS",
  OTHER: "OTHER",
};

export const CAPTURE_SOURCES = ["EXTENSION", "DESKTOP", "WEB", "BOT"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const MEETING_MODES = [
  "GENERAL",
  "LECTURE",
  "INTERVIEW",
  "PROJECT",
  "ONE_ON_ONE",
  "AUTO",
] as const;
export type MeetingMode = (typeof MEETING_MODES)[number];

/** Left channel = the user's mic, right = everyone else. */
export const CHANNEL_LAYOUTS = ["stereo-mic-left", "mono"] as const;
export type ChannelLayout = (typeof CHANNEL_LAYOUTS)[number];

/**
 * Segments from chunk `seq` get idx = seq * SEGMENTS_PER_CHUNK + i, so
 * live idx values are sparse but ordered by seq no matter when chunks
 * arrive. Always reference segments by idx, never by array position.
 */
export const SEGMENTS_PER_CHUNK = 1000;

/** Keeps seq * SEGMENTS_PER_CHUNK inside a 32-bit Int column. */
export const MAX_SEQ = Math.floor(2_147_483_647 / SEGMENTS_PER_CHUNK) - 1;

export const segmentIdxFor = (seq: number, position: number): number =>
  seq * SEGMENTS_PER_CHUNK + position;

export const LIMITS = {
  hints: 20,
  hintLength: 500,
  participants: 100,
  participantLength: 120,
} as const;
