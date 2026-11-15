import type { QueueDefinition } from "./queue";

/**
 * Queue names and their retry/expiry policy.
 *
 * Every queue uses the "stately" policy with the meeting id (or session
 * id) as singletonKey: one job waiting and one running per meeting.
 * Gemini stages back off from 30 s (30, 60 s), enough for a 503 burst;
 * a 429 from an exhausted daily quota will still fail, readably, and
 * the user retries later from the page. Expiry is the longest one
 * attempt may legitimately take; the heartbeat lets pg-boss retry a
 * killed process's job within a minute instead of waiting for expiry.
 */
export const Queues = {
  TRANSCRIBE: "meeting-transcribe",
  DIARIZE: "meeting-diarize",
  CLEAN: "meeting-clean",
  SUMMARIZE: "meeting-summarize",
  INDEX: "meeting-index",
  LIVE_ASSEMBLE: "live-assemble",
  LIVE_LATE: "live-late",
  LIVE_REAP: "live-reap",
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];

const HEARTBEAT_SECONDS = 30;

export const QUEUE_DEFINITIONS: QueueDefinition[] = [
  {
    name: Queues.TRANSCRIBE,
    retryLimit: 3,
    retryDelaySeconds: 15,
    retryBackoff: true,
    // TRANSCRIPTION_TIMEOUT_MINUTES (15) plus headroom.
    expireInSeconds: 30 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  },
  {
    name: Queues.DIARIZE,
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  },
  {
    name: Queues.CLEAN,
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  },
  {
    name: Queues.SUMMARIZE,
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    // The v2 pipeline can take 5-9 minutes when Gemini retries 503s.
    expireInSeconds: 30 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  },
  {
    name: Queues.INDEX,
    retryLimit: 3,
    retryDelaySeconds: 60,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  },
  {
    name: Queues.LIVE_ASSEMBLE,
    retryLimit: 2,
    retryDelaySeconds: 15,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  },
  {
    name: Queues.LIVE_LATE,
    retryLimit: 3,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  },
  {
    name: Queues.LIVE_REAP,
    retryLimit: 0,
    retryDelaySeconds: 60,
    retryBackoff: false,
    expireInSeconds: 5 * 60,
  },
];

/** The per-meeting pipeline queues, in order. */
export const PIPELINE_QUEUES: readonly QueueName[] = [
  Queues.LIVE_ASSEMBLE,
  Queues.TRANSCRIBE,
  Queues.DIARIZE,
  Queues.CLEAN,
  Queues.SUMMARIZE,
];

/** Where a pipeline job came from; changes how failures and the live path behave. */
export type PipelineOrigin =
  | "upload"
  | "summarize"
  | "resummarize"
  | "retry"
  | "live-final"
  | "late";

export interface PipelineJob {
  meetingId: string;
  origin: PipelineOrigin;
  /** resummarize: IANA zone for resolving deadlines. */
  timezone?: string | null;
}
