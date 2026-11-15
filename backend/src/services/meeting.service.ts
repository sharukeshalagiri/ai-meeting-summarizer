import fs from "fs/promises";
import path from "path";
import { Queues, type PipelineJob } from "../jobs/definitions";
import { parseFailure, PROCESSING_NOTES, SUMMARY_FAILED } from "../jobs/errors";
import {
  assertJobsAvailable,
  enqueue,
  isPipelineBusy,
  memoryJobPromise,
} from "../jobs/index";
import { setProgress, waitForMeeting, watchMeeting } from "../jobs/progress";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import * as meetingRepo from "../repositories/meeting.repository";
import * as segmentRepo from "../repositories/segment.repository";
import * as transcriptRepo from "../repositories/transcript.repository";
import * as userRepo from "../repositories/user.repository";
import { AppError, BadRequest, NotFound, UpstreamError } from "../types/errors";
import { MeetingStatus, ProcessingStage } from "../types/meeting";

const log = logger.child({ module: "meeting.service" });

/**
 * Meetings and their processing.
 *
 * The processing itself (transcribe, diarize, clean, summarize, index)
 * runs as durable jobs (src/jobs, pg-boss); this service validates a
 * request, records the stage and queues the right step. GET
 * /meetings/:id/events streams the progress.
 */

export const createMeeting = async (input: {
  title: string;
  description: string | null;
  userId?: string | null;
  source?: string;
  platform?: string | null;
  mode?: string;
}) => {
  // The MVP is single-user: fall back to the existing account so the
  // client does not have to hardcode an id.
  const ownerId = input.userId ?? (await userRepo.findFirst())?.id;

  if (!ownerId) {
    throw BadRequest(
      "No user exists yet. Create one via POST /api/users first."
    );
  }

  const meeting = await meetingRepo.create({
    title: input.title,
    description: input.description,
    userId: ownerId,
    source: input.source ?? "UPLOAD",
    platform: input.platform ?? null,
    ...(input.mode ? { mode: input.mode } : {}),
  });

  log.info("Meeting created", {
    meetingId: meeting.id,
    source: meeting.source,
  });

  return meeting;
};

export const listMeetings = () => meetingRepo.findAll();

export const getMeeting = async (meetingId: string) => {
  const meeting = await meetingRepo.findById(meetingId);

  if (!meeting) {
    throw NotFound("Meeting not found");
  }

  return meeting;
};

/**
 * Absolute path of a meeting's stored recording, for streaming.
 *
 * Uploads point at the multer file; live meetings point at the
 * recording assembled from their chunks once the session has ended
 * (until then they 404 like a meeting with no upload).
 */
export const getAudioFile = async (meetingId: string): Promise<string> => {
  const meeting = await getMeeting(meetingId);

  if (!meeting.audioPath) {
    throw NotFound("This meeting has no stored recording");
  }

  // audioPath is written by the server (multer, or Storage.relativePath
  // for live recordings), relative to the backend's working directory.
  const absolutePath = path.resolve(meeting.audioPath);

  try {
    await fs.access(absolutePath);
  } catch {
    throw NotFound("The recording file is missing");
  }

  return absolutePath;
};

/**
 * Status and processing* columns only (the progress stream). 503 while
 * the queue is down: nothing would move, and the page should say so.
 */
export const getProgress = async (meetingId: string) => {
  assertJobsAvailable();

  const row = await meetingRepo.findProgress(meetingId);

  if (!row) {
    throw NotFound("Meeting not found");
  }

  return row;
};

/** Subscribes to a meeting's progress (GET /meetings/:id/events). */
export const watchProgress = watchMeeting;

/** Throws unless the meeting exists; avoids loading relations. */
const assertExists = async (meetingId: string): Promise<void> => {
  if (!(await meetingRepo.exists(meetingId))) {
    throw NotFound("Meeting not found");
  }
};

export const deleteMeeting = async (meetingId: string) => {
  await assertExists(meetingId);

  // Every dependent row cascades, so one delete is enough.
  await meetingRepo.remove(meetingId);

  log.info("Meeting deleted", { meetingId });
};

/** Records the uploaded file against the meeting. */
export const attachAudio = async (
  meetingId: string,
  audioPath: string
) => {
  await assertExists(meetingId);

  const meeting = await meetingRepo.updateAudio(
    meetingId,
    audioPath,
    MeetingStatus.CREATED
  );

  log.info("Audio attached", { meetingId, audioPath });

  return meeting;
};

/** What the processing endpoints answer while jobs run (202). */
const processingState = (meetingId: string, stage: string | null) => ({
  meetingId,
  status: MeetingStatus.PROCESSING,
  processingStage: stage,
});

/** The meeting's current stage, for answers when nothing new was queued. */
const currentState = async (meetingId: string) => {
  const row = await meetingRepo.findProgress(meetingId);
  return processingState(meetingId, row?.processingStage ?? null);
};

/**
 * Queues the whole pipeline for an uploaded recording (transcribe ->
 * diarize -> clean -> summarize -> index) and returns at once. While any
 * step is queued or running for the meeting, it queues nothing new.
 */
export const startProcessing = async (meetingId: string) => {
  const meeting = await getMeeting(meetingId);

  if (!meeting.audioPath) {
    throw BadRequest("No audio uploaded for this meeting");
  }

  if (await isPipelineBusy(meetingId)) return currentState(meetingId);

  await setProgress(meetingId, {
    stage: ProcessingStage.TRANSCRIBING,
    progress: 0,
    error: null,
    status: MeetingStatus.PROCESSING,
  });

  await enqueue(
    Queues.TRANSCRIBE,
    { meetingId, origin: "upload" } satisfies PipelineJob,
    { singletonKey: meetingId }
  );

  log.info("Processing queued", { meetingId });

  return processingState(meetingId, ProcessingStage.TRANSCRIBING);
};

/** Stages at or after the point where the transcript exists. */
const TRANSCRIBED_STAGES: readonly string[] = [
  ProcessingStage.CLEANING,
  ProcessingStage.SUMMARIZING,
  ProcessingStage.DONE,
  ProcessingStage.NO_SPEECH,
];

/**
 * POST /transcribe, kept for API clients: queues the pipeline (see
 * startProcessing) and waits until the transcript is written, then
 * returns it as before. The summary carries on in the background, so a
 * following POST /summarize finds it already queued and adds nothing.
 */
export const transcribeMeeting = async (meetingId: string) => {
  await startProcessing(meetingId);

  const row = await waitForMeeting(
    meetingId,
    (current) =>
      current.processingStage === ProcessingStage.FAILED ||
      TRANSCRIBED_STAGES.includes(current.processingStage ?? ""),
    env.transcriptionTimeoutMs
  );

  if (!row) {
    throw new AppError(
      "Transcription is taking longer than expected. The meeting page shows its progress.",
      504
    );
  }

  if (row.processingStage === ProcessingStage.FAILED) {
    throw UpstreamError(
      parseFailure(row.processingError)?.message ?? "Transcription failed."
    );
  }

  const transcript = await transcriptRepo.findByMeetingId(meetingId);

  if (!transcript) throw NotFound("Transcript not found");

  return transcript;
};

/**
 * Meeting.processingStage values. Defined in types/meeting.ts, so code
 * that mocks this service in tests still has them, and re-exported here.
 */
export { ProcessingStage };

/** User-safe processingError messages (never upstream error text). */
export const PROCESSING_ERRORS = {
  V2_FALLBACK: PROCESSING_NOTES.V2_FALLBACK,
  FAILED: SUMMARY_FAILED,
} as const;

/**
 * The in-flight summary job for a meeting, if any. Only the in-process
 * queue (tests, JOBS_DRIVER=memory) can hand out a promise; with pg-boss
 * this is always undefined: use isPipelineBusy instead.
 */
export const summaryJob = (meetingId: string): Promise<void> | undefined =>
  memoryJobPromise(Queues.SUMMARIZE, meetingId);

/**
 * Queues the summary of a transcribed meeting and returns at once
 * (POST /summarize answers 202; the page follows GET /meetings/:id/events).
 * Nothing new is queued while a pipeline step is queued or running for
 * the meeting: that run ends in a summary anyway.
 */
export const startSummary = async (meetingId: string) => {
  await assertExists(meetingId);

  const transcript = await transcriptRepo.findByMeetingId(meetingId);

  if (!transcript) {
    throw NotFound("Transcript not found");
  }

  if (!(await isPipelineBusy(meetingId))) {
    await setProgress(meetingId, {
      stage: ProcessingStage.SUMMARIZING,
      progress: 0,
      error: null,
      status: MeetingStatus.PROCESSING,
    });

    await enqueue(
      Queues.SUMMARIZE,
      { meetingId, origin: "summarize" } satisfies PipelineJob,
      { singletonKey: meetingId }
    );
  }

  return processingState(meetingId, ProcessingStage.SUMMARIZING);
};

/**
 * POST /meetings/:id/retry: resumes a meeting whose pipeline failed (or
 * stalled). With segments it re-runs from CLEAN (clean, summarize,
 * index); without them it transcribes the recording again.
 */
export const retryProcessing = async (meetingId: string) => {
  const meeting = await getMeeting(meetingId);

  if (await isPipelineBusy(meetingId)) return currentState(meetingId);

  if ((await segmentRepo.countByMeetingId(meetingId)) > 0) {
    await setProgress(meetingId, {
      stage: ProcessingStage.CLEANING,
      progress: 0,
      error: null,
      status: MeetingStatus.PROCESSING,
    });

    await enqueue(
      Queues.CLEAN,
      { meetingId, origin: "retry" } satisfies PipelineJob,
      { singletonKey: meetingId }
    );

    log.info("Retry queued from CLEAN", { meetingId });

    return processingState(meetingId, ProcessingStage.CLEANING);
  }

  if (!meeting.audioPath) {
    throw BadRequest(
      "There is nothing to retry: this meeting has no recording and no transcript."
    );
  }

  return startProcessing(meetingId);
};

/**
 * Single-request upload flow: attach the file and queue the pipeline.
 * The response no longer contains the transcript: everything runs as
 * jobs and GET /meetings/:id/events reports progress.
 */
export const processMeeting = async (
  meetingId: string,
  audioPath: string
) => {
  const meeting = await attachAudio(meetingId, audioPath);
  const processing = await startProcessing(meetingId);

  return {
    meeting: { ...meeting, status: processing.status },
    transcript: null,
    summary: null,
    processing,
  };
};
