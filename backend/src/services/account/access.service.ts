import * as accessRepo from "../../repositories/access.repository";
import { NotFound } from "../../types/errors";

/**
 * Ownership checks. A row that belongs to someone else answers exactly
 * like a row that does not exist (404 with the same message), so ids
 * from another account reveal nothing, not even that they exist.
 */

export const assertMeetingOwner = async (userId: string, meetingId: string) => {
  if ((await accessRepo.meetingOwnerId(meetingId)) !== userId) {
    throw NotFound("Meeting not found");
  }
};

export const assertLiveSessionOwner = async (userId: string, sessionId: string) => {
  if ((await accessRepo.liveSessionOwnerId(sessionId)) !== userId) {
    throw NotFound("Live session not found");
  }
};

export const assertActionItemOwner = async (userId: string, itemId: string) => {
  if ((await accessRepo.actionItemOwnerId(itemId)) !== userId) {
    throw NotFound("Action item not found");
  }
};

export const assertSeriesOwner = async (userId: string, seriesId: string) => {
  if ((await accessRepo.seriesOwnerId(seriesId)) !== userId) {
    throw NotFound("Series not found");
  }
};

/**
 * A chat thread may be read or extended only by its owner. A thread id
 * nobody has used yet is free (the client may pick a new id); a thread
 * from before accounts, with no owner, belongs to no one.
 */
export const assertConversationAccess = async (
  userId: string,
  conversationId: string,
  options: { mustExist: boolean }
) => {
  const owner = await accessRepo.conversationOwnerId(conversationId);

  if (owner === null && !options.mustExist) return;
  if (owner !== userId) throw NotFound("Conversation not found");
};
