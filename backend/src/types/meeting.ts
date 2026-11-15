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
 *
 * The job pipeline (backend/src/jobs, w3-jobs) moves a meeting through
 * them in order: ASSEMBLING (live meetings only: chunks -> one
 * recording), TRANSCRIBING, DIARIZING, CLEANING, SUMMARIZING, then DONE.
 * A stage is written when its job is queued, so it means "waiting for or
 * running this step". Search indexing runs after DONE and has no stage.
 * The meeting page follows them over SSE (GET /meetings/:id/events).
 *
 * FAILED: processingError says which stage failed and why
 * ("[SUMMARIZING/RATE_LIMITED] ..."); POST /meetings/:id/retry resumes.
 *
 * NO_SPEECH: a live capture ended with no transcribed speech (wrong tab
 * shared, or silence throughout). That is not a failure, there is just
 * nothing to summarize, so the meeting is COMPLETED with this stage. A
 * late chunk with speech moves it back to TRANSCRIBED and summarizes.
 */
export const ProcessingStage = {
  ASSEMBLING: "ASSEMBLING",
  TRANSCRIBING: "TRANSCRIBING",
  DIARIZING: "DIARIZING",
  CLEANING: "CLEANING",
  SUMMARIZING: "SUMMARIZING",
  DONE: "DONE",
  FAILED: "FAILED",
  NO_SPEECH: "NO_SPEECH",
} as const;

export type ProcessingStageValue =
  (typeof ProcessingStage)[keyof typeof ProcessingStage];

/** Stages during which a job is queued or running for the meeting. */
export const ACTIVE_STAGES: readonly string[] = [
  ProcessingStage.ASSEMBLING,
  ProcessingStage.TRANSCRIBING,
  ProcessingStage.DIARIZING,
  ProcessingStage.CLEANING,
  ProcessingStage.SUMMARIZING,
];

export const isActiveStage = (stage: string | null | undefined): boolean =>
  stage != null && ACTIVE_STAGES.includes(stage);
