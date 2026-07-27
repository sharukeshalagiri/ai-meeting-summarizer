import * as summaryRepo from "../repositories/summary.repository";
import { NotFound } from "../types/errors";

/**
 * Read access to stored summaries.
 *
 * Kept separate from summary.service.ts, which owns Gemini generation:
 * one talks to the database, the other to an external API.
 */
export const getSummaryByMeeting = async (meetingId: string) => {
  const summary = await summaryRepo.findByMeetingId(meetingId);

  if (!summary) {
    throw NotFound("Summary not found");
  }

  return summary;
};
