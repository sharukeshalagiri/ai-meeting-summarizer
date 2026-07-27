import * as transcriptRepo from "../repositories/transcript.repository";
import { NotFound } from "../types/errors";

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
