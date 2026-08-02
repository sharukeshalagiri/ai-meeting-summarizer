import * as actionItemRepo from "../repositories/actionItem.repository";
import { BadRequest, NotFound } from "../types/errors";

/** Statuses a task can be moved between from the UI. */
const STATUSES = new Set(["PENDING", "COMPLETED"]);

export const listActionItems = (status?: string | null) => {
  if (status && !STATUSES.has(status.toUpperCase())) {
    throw BadRequest("status must be PENDING or COMPLETED");
  }

  return actionItemRepo.findAll(status?.toUpperCase());
};

export const listByMeeting = (meetingId: string) =>
  actionItemRepo.findByMeetingId(meetingId);

export const setStatus = async (
  id: string,
  status: string | null
) => {
  const next = status?.toUpperCase();

  if (!next || !STATUSES.has(next)) {
    throw BadRequest("status must be PENDING or COMPLETED");
  }

  if (!(await actionItemRepo.findById(id))) {
    throw NotFound("Action item not found");
  }

  return actionItemRepo.updateStatus(
    id,
    next,
    next === "COMPLETED" ? new Date() : null
  );
};
