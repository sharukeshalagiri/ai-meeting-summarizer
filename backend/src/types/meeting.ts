/**
 * Lifecycle of a meeting's processing pipeline.
 *
 * Kept as a const object rather than a Prisma enum because `status` is
 * a plain String column; introducing a database enum would require a
 * migration for every new state.
 */
export const MeetingStatus = {
  CREATED: "CREATED",
  /** Browser tab capture in progress; only live meetings enter this. */
  LIVE: "LIVE",
  PROCESSING: "PROCESSING",
  TRANSCRIBED: "TRANSCRIBED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type MeetingStatusValue =
  (typeof MeetingStatus)[keyof typeof MeetingStatus];
