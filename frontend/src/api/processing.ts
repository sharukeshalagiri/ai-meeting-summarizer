import { API_BASE_URL, postData } from "./api";
import type { ProcessingState } from "../types/processing";

/** Background-processing endpoints (backend routes/processing.routes.ts). */

/** Queues transcribe -> diarize -> clean -> summarize -> index (202). */
export const startProcessing = (meetingId: string) =>
  postData<ProcessingState>(`/meetings/${meetingId}/process`);

/** Resumes a failed or stalled pipeline from the right step (202). */
export const retryProcessing = (meetingId: string) =>
  postData<ProcessingState>(`/meetings/${meetingId}/retry`);

/**
 * The progress stream. EventSource cannot send an Authorization header,
 * which is fine while /meetings has no auth (accounts add a cookie or a
 * short-lived query token).
 */
export const meetingEventsUrl = (meetingId: string) =>
  `${API_BASE_URL}/meetings/${meetingId}/events`;
