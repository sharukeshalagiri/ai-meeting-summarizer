import fs from "fs/promises";
import path from "path";
import { logger } from "../lib/logger";
import * as actionItemRepo from "../repositories/actionItem.repository";
import * as meetingRepo from "../repositories/meeting.repository";
import * as segmentRepo from "../repositories/segment.repository";
import * as summaryRepo from "../repositories/summary.repository";
import * as transcriptRepo from "../repositories/transcript.repository";
import * as userRepo from "../repositories/user.repository";
import { BadRequest, NotFound } from "../types/errors";
import { MeetingStatus, type MeetingStatusValue } from "../types/meeting";
import { toSpeakerTranscript } from "../types/segment";
import { toJsonValue } from "../types/summary";
import { diarizeSegments } from "./diarization.service";
import { indexMeeting } from "./embedding.service";
import { transcribeAudioDetailed } from "./speech.service";
import { generateSummary } from "./summary.service";
import { resummarize } from "./w1-sum.service";

const log = logger.child({ module: "meeting.service" });

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
 * Live meetings have no single recording (their audio is stored as
 * chunks), so they 404 like a meeting with no upload.
 */
export const getAudioFile = async (meetingId: string): Promise<string> => {
  const meeting = await getMeeting(meetingId);

  if (!meeting.audioPath) {
    throw NotFound("This meeting has no stored recording");
  }

  // audioPath is written by the server (multer), relative to the
  // backend's working directory.
  const absolutePath = path.resolve(meeting.audioPath);

  try {
    await fs.access(absolutePath);
  } catch {
    throw NotFound("The recording file is missing");
  }

  return absolutePath;
};

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

const setStatus = (meetingId: string, status: MeetingStatusValue) =>
  meetingRepo.updateStatus(meetingId, status);

/** Best effort: bookkeeping must never mask the original failure. */
const markFailed = async (meetingId: string): Promise<void> => {
  try {
    await setStatus(meetingId, MeetingStatus.FAILED);
  } catch (error) {
    log.warn("Could not mark meeting as failed", {
      meetingId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
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

/**
 * Runs Whisper for a meeting, attributes speakers, and stores both the
 * flat transcript and its timestamped segments.
 */
export const transcribeMeeting = async (meetingId: string) => {
  const meeting = await getMeeting(meetingId);

  if (!meeting.audioPath) {
    throw BadRequest("No audio uploaded for this meeting");
  }

  await setStatus(meetingId, MeetingStatus.PROCESSING);

  try {
    const startedAt = Date.now();

    const result = await transcribeAudioDetailed(meeting.audioPath);

    const transcript = await transcriptRepo.upsert(
      meetingId,
      result.text
    );

    if (result.segments.length) {
      const diarized = await diarizeSegments(result.segments);

      await segmentRepo.replaceForMeeting(meetingId, diarized);
    }

    if (result.durationMs > 0) {
      await meetingRepo.updateDuration(
        meetingId,
        Math.round(result.durationMs / 1000)
      );
    }

    await setStatus(meetingId, MeetingStatus.TRANSCRIBED);

    log.info("Transcription complete", {
      meetingId,
      durationMs: Date.now() - startedAt,
      characters: result.text.length,
      segments: result.segments.length,
    });

    return transcript;
  } catch (error) {
    log.error("Transcription failed", error, { meetingId });

    await markFailed(meetingId);

    throw error;
  }
};

/**
 * Builds the text the summarizer reads.
 *
 * Prefers the speaker-attributed script so the model can tell who
 * committed to what, and falls back to the flat transcript for
 * meetings recorded before diarization existed.
 */
const summarizationInput = async (
  meetingId: string,
  fallback: string
): Promise<string> => {
  const segments = await segmentRepo.findByMeetingId(meetingId);

  return segments.length ? toSpeakerTranscript(segments) : fallback;
};

/**
 * Meeting.processingStage values for the summary step. The meeting page
 * polls while the stage is SUMMARIZING.
 */
export const ProcessingStage = {
  SUMMARIZING: "SUMMARIZING",
  DONE: "DONE",
  FAILED: "FAILED",
} as const;

/** User-safe processingError messages (never upstream error text). */
export const PROCESSING_ERRORS = {
  V2_FALLBACK:
    "The detailed summary could not be generated, so a basic summary was used instead.",
  FAILED: "The summary could not be generated. Retry from the meeting page.",
} as const;

/**
 * Summaries running in this process, by meeting id.
 *
 * The summary runs in the background, in-process, because the v2
 * pipeline can take 5-9 minutes when Gemini retries 503s, longer than
 * Node's default 5-minute request timeout. This is deliberately minimal:
 * a restart loses the run (the meeting page stops polling after a cap
 * and offers a retry). Pair 4 (w3-jobs) replaces it with pg-boss.
 */
const running = new Map<string, Promise<void>>();

/** The in-flight summary for a meeting, if any (tests and smoke runs). */
export const summaryJob = (meetingId: string): Promise<void> | undefined =>
  running.get(meetingId);

/** The legacy single-prompt summary, kept as the v2 pipeline's fallback. */
const legacySummary = async (meetingId: string, transcript: string) => {
  const { structured, markdown } = await generateSummary(
    await summarizationInput(meetingId, transcript)
  );

  await summaryRepo.upsert(
    meetingId,
    markdown,
    { ...toJsonValue(structured), pipeline: "legacy" },
    structured.sentiment.overall
  );

  // Action items are promoted to rows so they can be tracked and
  // counted across meetings, not just read inside one summary.
  await actionItemRepo.replaceForMeeting(meetingId, structured.actionItems);
};

/**
 * Produces the final summary: the w1-sum v2 pipeline first (which keeps
 * human-reviewed action items and stores CLEAN noise labels), then the
 * legacy summarizer if v2 throws. Summary.data.pipeline records which
 * one produced it. Never throws: the outcome lands on the meeting row.
 */
const runSummary = async (meetingId: string, transcript: string) => {
  const startedAt = Date.now();

  try {
    let pipeline: "v2" | "legacy" = "v2";

    try {
      await resummarize(meetingId);
    } catch (error) {
      log.error("Summary pipeline v2 failed; using the legacy summary", error, {
        meetingId,
      });

      pipeline = "legacy";

      await meetingRepo.updateProcessing(meetingId, {
        error: PROCESSING_ERRORS.V2_FALLBACK,
        progress: 50,
      });

      await legacySummary(meetingId, transcript);
    }

    await meetingRepo.updateProcessing(meetingId, {
      stage: ProcessingStage.DONE,
      progress: 100,
      status: MeetingStatus.COMPLETED,
    });

    log.info("Summary complete", {
      meetingId,
      pipeline,
      durationMs: Date.now() - startedAt,
    });

    // Indexing powers search and chat, but a meeting is complete
    // without it, so a failure here is logged rather than surfaced.
    void indexMeeting(meetingId).catch((error) => {
      log.warn("Background indexing failed", {
        meetingId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    log.error("Summary generation failed", error, { meetingId });

    await meetingRepo
      .updateProcessing(meetingId, {
        stage: ProcessingStage.FAILED,
        error: PROCESSING_ERRORS.FAILED,
        status: MeetingStatus.FAILED,
      })
      .catch((markError) =>
        log.error("Could not record the summary failure", markError, {
          meetingId,
        })
      );
  }
};

/**
 * Starts summarizing a transcribed meeting in the background and
 * returns at once (POST /summarize answers 202; the client polls
 * GET /meetings/:id). A second call while one is running does not start
 * another.
 */
export const startSummary = async (meetingId: string) => {
  await assertExists(meetingId);

  const transcript = await transcriptRepo.findByMeetingId(meetingId);

  if (!transcript) {
    throw NotFound("Transcript not found");
  }

  if (!running.has(meetingId)) {
    // Claimed synchronously, before any await, so two concurrent
    // requests cannot both start a run.
    let release: () => void = () => {};
    running.set(
      meetingId,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    try {
      await meetingRepo.updateProcessing(meetingId, {
        stage: ProcessingStage.SUMMARIZING,
        progress: 0,
        error: null,
        status: MeetingStatus.PROCESSING,
      });
    } catch (error) {
      running.delete(meetingId);
      release();
      throw error;
    }

    void runSummary(meetingId, transcript.content).finally(() => {
      running.delete(meetingId);
      release();
    });
  }

  return {
    meetingId,
    status: MeetingStatus.PROCESSING,
    processingStage: ProcessingStage.SUMMARIZING,
  };
};

/**
 * Single-request upload flow: attach, transcribe, then start the
 * background summary. The staged frontend calls transcribe and
 * summarize separately so it can report progress.
 */
export const processMeeting = async (
  meetingId: string,
  audioPath: string
) => {
  const meeting = await attachAudio(meetingId, audioPath);

  const transcript = await transcribeMeeting(meetingId);
  const processing = await startSummary(meetingId);

  // The summary is no longer part of this response: it runs in the
  // background like POST /summarize, and GET /meetings/:id reports it.
  return {
    meeting: { ...meeting, status: processing.status },
    transcript,
    summary: null,
    processing,
  };
};
