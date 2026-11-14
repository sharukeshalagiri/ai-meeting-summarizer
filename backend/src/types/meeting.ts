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

/**
 * Meeting.processingStage values (a plain String column, like status).
 * The meeting page polls while the stage is SUMMARIZING.
 *
 * NO_SPEECH: a live capture ended with no transcribed speech (wrong tab
 * shared, or silence throughout). That is not a failure, there is just
 * nothing to summarize, so the meeting is COMPLETED with this stage. A
 * late chunk with speech moves it back to TRANSCRIBED and summarizes.
 */
export const ProcessingStage = {
  SUMMARIZING: "SUMMARIZING",
  DONE: "DONE",
  FAILED: "FAILED",
  NO_SPEECH: "NO_SPEECH",
} as const;

export type ProcessingStageValue =
  (typeof ProcessingStage)[keyof typeof ProcessingStage];
