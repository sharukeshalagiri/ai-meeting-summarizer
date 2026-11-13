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

/** Runs Gemini over a stored transcript and saves the summary. */
export const summarizeMeeting = async (meetingId: string) => {
  await assertExists(meetingId);

  const transcript = await transcriptRepo.findByMeetingId(meetingId);

  if (!transcript) {
    throw NotFound("Transcript not found");
  }

  try {
    const startedAt = Date.now();

    const { structured, markdown } = await generateSummary(
      await summarizationInput(meetingId, transcript.content)
    );

    const summary = await summaryRepo.upsert(
      meetingId,
      markdown,
      toJsonValue(structured),
      structured.sentiment.overall
    );

    // Action items are promoted to rows so they can be tracked and
    // counted across meetings, not just read inside one summary.
    await actionItemRepo.replaceForMeeting(
      meetingId,
      structured.actionItems
    );

    await setStatus(meetingId, MeetingStatus.COMPLETED);

    log.info("Summary complete", {
      meetingId,
      durationMs: Date.now() - startedAt,
      actionItems: structured.actionItems.length,
      sentiment: structured.sentiment.overall,
    });

    // Indexing powers search and chat, but a meeting is complete
    // without it, so a failure here is logged rather than surfaced.
    void indexMeeting(meetingId).catch((error) => {
      log.warn("Background indexing failed", {
        meetingId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });

    return summary;
  } catch (error) {
    log.error("Summary generation failed", error, { meetingId });

    await markFailed(meetingId);

    throw error;
  }
};

/**
 * Full pipeline used by the single-request upload flow. The staged
 * frontend calls transcribe and summarize separately so it can report
 * progress.
 */
export const processMeeting = async (
  meetingId: string,
  audioPath: string
) => {
  const meeting = await attachAudio(meetingId, audioPath);

  const transcript = await transcribeMeeting(meetingId);
  const summary = await summarizeMeeting(meetingId);

  return {
    meeting: { ...meeting, status: MeetingStatus.COMPLETED },
    transcript,
    summary,
  };
};
