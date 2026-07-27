import { logger } from "../lib/logger";
import * as meetingRepo from "../repositories/meeting.repository";
import * as summaryRepo from "../repositories/summary.repository";
import * as transcriptRepo from "../repositories/transcript.repository";
import * as userRepo from "../repositories/user.repository";
import { BadRequest, NotFound } from "../types/errors";
import { MeetingStatus, type MeetingStatusValue } from "../types/meeting";
import { toJsonValue } from "../types/summary";
import { transcribeAudio } from "./speech.service";
import { generateSummary } from "./summary.service";

const log = logger.child({ module: "meeting.service" });

export const createMeeting = async (input: {
  title: string;
  description: string | null;
  userId?: string | null;
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
  });

  log.info("Meeting created", { meetingId: meeting.id });

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

/** Throws unless the meeting exists; avoids loading relations. */
const assertExists = async (meetingId: string): Promise<void> => {
  if (!(await meetingRepo.exists(meetingId))) {
    throw NotFound("Meeting not found");
  }
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

/** Runs Whisper for a meeting and stores the result. */
export const transcribeMeeting = async (meetingId: string) => {
  const meeting = await getMeeting(meetingId);

  if (!meeting.audioPath) {
    throw BadRequest("No audio uploaded for this meeting");
  }

  await setStatus(meetingId, MeetingStatus.PROCESSING);

  try {
    const startedAt = Date.now();

    const content = await transcribeAudio(meeting.audioPath);

    const transcript = await transcriptRepo.upsert(meetingId, content);

    await setStatus(meetingId, MeetingStatus.TRANSCRIBED);

    log.info("Transcription complete", {
      meetingId,
      durationMs: Date.now() - startedAt,
      characters: content.length,
    });

    return transcript;
  } catch (error) {
    log.error("Transcription failed", error, { meetingId });

    await markFailed(meetingId);

    throw error;
  }
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
      transcript.content
    );

    const summary = await summaryRepo.upsert(
      meetingId,
      markdown,
      toJsonValue(structured)
    );

    await setStatus(meetingId, MeetingStatus.COMPLETED);

    log.info("Summary complete", {
      meetingId,
      durationMs: Date.now() - startedAt,
      actionItems: structured.actionItems.length,
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
