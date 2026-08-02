import * as segmentRepo from "../repositories/segment.repository";
import * as transcriptRepo from "../repositories/transcript.repository";
import { NotFound } from "../types/errors";
import { formatTimestamp } from "../types/segment";

export const listTranscripts = () => transcriptRepo.findAll();

export const createTranscript = (input: {
  meetingId: string;
  content: string;
}) => transcriptRepo.create(input);

export const getTranscriptByMeeting = async (meetingId: string) => {
  const transcript = await transcriptRepo.findByMeetingId(meetingId);

  if (!transcript) {
    throw NotFound("Transcript not found");
  }

  return transcript;
};

/**
 * Timestamped, speaker-attributed segments for the transcript reader.
 *
 * Returns an empty list rather than 404 for meetings transcribed
 * before diarization existed: they have a transcript, just not
 * segments, and the reader falls back to the flat text.
 */
export const getSegmentsByMeeting = async (meetingId: string) => {
  const segments = await segmentRepo.findByMeetingId(meetingId);

  return segments.map((segment) => ({
    ...segment,
    timestamp: formatTimestamp(segment.startMs),
  }));
};
