import { prisma } from "../lib/prisma";
import { BadRequest, NotFound } from "../types/errors";
import { toJsonValue } from "../types/summary";
import { transcribeAudio } from "./speech.service";
import { generateSummary } from "./summary.service";

export const MeetingStatus = {
  CREATED: "CREATED",
  PROCESSING: "PROCESSING",
  TRANSCRIBED: "TRANSCRIBED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type MeetingStatusValue =
  (typeof MeetingStatus)[keyof typeof MeetingStatus];

const withRelations = {
  transcript: true,
  summary: true,
} as const;

export const createMeeting = async (input: {
  title?: unknown;
  description?: unknown;
  userId?: unknown;
}) => {
  const title =
    typeof input.title === "string" ? input.title.trim() : "";

  if (!title) {
    throw BadRequest("title is required");
  }

  const description =
    typeof input.description === "string" ? input.description : null;

  // The MVP is single-user: fall back to the existing account so the
  // client does not have to hardcode an id.
  const ownerId =
    typeof input.userId === "string" && input.userId
      ? input.userId
      : (
          await prisma.user.findFirst({
            orderBy: { createdAt: "asc" },
          })
        )?.id;

  if (!ownerId) {
    throw BadRequest(
      "No user exists yet. Create one via POST /api/users first."
    );
  }

  return prisma.meeting.create({
    data: { title, description, userId: ownerId },
  });
};

export const listMeetings = async () =>
  prisma.meeting.findMany({
    orderBy: { createdAt: "desc" },
    include: withRelations,
  });

export const getMeeting = async (meetingId: string) => {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    include: withRelations,
  });

  if (!meeting) {
    throw NotFound("Meeting not found");
  }

  return meeting;
};

export const setStatus = async (
  meetingId: string,
  status: MeetingStatusValue
) =>
  prisma.meeting.update({
    where: { id: meetingId },
    data: { status },
  });

/** Records the uploaded file against the meeting. */
export const attachAudio = async (
  meetingId: string,
  audioPath: string
) => {
  await getMeeting(meetingId);

  return prisma.meeting.update({
    where: { id: meetingId },
    data: { audioPath, status: MeetingStatus.CREATED },
  });
};

/** Runs Whisper for a meeting and stores the result. */
export const transcribeMeeting = async (meetingId: string) => {
  const meeting = await getMeeting(meetingId);

  if (!meeting.audioPath) {
    throw BadRequest("No audio uploaded for this meeting");
  }

  await setStatus(meetingId, MeetingStatus.PROCESSING);

  try {
    const content = await transcribeAudio(meeting.audioPath);

    const transcript = await prisma.transcript.upsert({
      where: { meetingId },
      update: { content },
      create: { meetingId, content },
    });

    await setStatus(meetingId, MeetingStatus.TRANSCRIBED);

    return transcript;
  } catch (error) {
    await markFailed(meetingId);
    throw error;
  }
};

/** Runs Gemini over a stored transcript and saves the summary. */
export const summarizeMeeting = async (meetingId: string) => {
  await getMeeting(meetingId);

  const transcript = await prisma.transcript.findUnique({
    where: { meetingId },
  });

  if (!transcript) {
    throw NotFound("Transcript not found");
  }

  try {
    const { structured, markdown } = await generateSummary(
      transcript.content
    );

    // Store both: `data` drives the rich UI, `content` stays readable
    // on its own and matches summaries created before this change.
    const data = toJsonValue(structured);

    const summary = await prisma.summary.upsert({
      where: { meetingId },
      update: { content: markdown, data },
      create: { meetingId, content: markdown, data },
    });

    await setStatus(meetingId, MeetingStatus.COMPLETED);

    return summary;
  } catch (error) {
    await markFailed(meetingId);
    throw error;
  }
};

/**
 * Full pipeline used by the single-request upload flow.
 * The staged frontend calls transcribe/summarize separately.
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

/**
 * Best-effort: never let bookkeeping mask the original failure.
 */
const markFailed = async (meetingId: string) => {
  await setStatus(meetingId, MeetingStatus.FAILED).catch(() => {
    /* the underlying error matters more */
  });
};
