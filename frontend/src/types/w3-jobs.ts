/**
 * Background-processing types (track w3-jobs), matching the backend's
 * GET /meetings/:id/events payload and the 202 bodies of
 * POST /meetings/:id/process and /retry.
 */

/** Meeting.processingStage values (backend types/meeting.ts). */
export type ProcessingStage =
  | "ASSEMBLING"
  | "TRANSCRIBING"
  | "DIARIZING"
  | "CLEANING"
  | "SUMMARIZING"
  | "DONE"
  | "FAILED"
  | "NO_SPEECH";

/** One `event: progress` on the SSE stream. */
export interface MeetingProgress {
  id: string;
  status: string;
  source?: string;
  processingStage: ProcessingStage | string | null;
  processingProgress: number | null;
  /** "[STAGE/KIND] message" on failure, or a plain note (fallback used). */
  processingError: string | null;
}

/** 202 body of POST /process and /retry. */
export interface ProcessingState {
  meetingId: string;
  status: string;
  processingStage: ProcessingStage | string | null;
}
