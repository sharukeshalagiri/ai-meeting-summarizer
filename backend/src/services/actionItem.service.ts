import * as actionItemRepo from "../repositories/actionItem.repository";
import { BadRequest, NotFound } from "../types/errors";

/** Statuses a task can be moved between from the UI. */
const STATUSES = new Set(["PENDING", "COMPLETED"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Task-board order: open before done, then by resolved due date
 * (soonest first), then undated items newest first. dueDate holds an
 * ISO day for v2 items; legacy rows may hold free text ("Friday"),
 * which cannot be compared and sorts with the undated ones.
 */
export const sortByDueDate = <
  T extends { status: string; dueDate: string | null; createdAt: Date | string },
>(
  items: T[]
): T[] => {
  const dated = (item: T) =>
    item.dueDate && ISO_DATE.test(item.dueDate) ? item.dueDate : null;
  const created = (item: T) => new Date(item.createdAt).getTime();

  return [...items].sort((a, b) => {
    const doneA = a.status === "COMPLETED" ? 1 : 0;
    const doneB = b.status === "COMPLETED" ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;

    const dueA = dated(a);
    const dueB = dated(b);
    if (dueA && dueB && dueA !== dueB) return dueA < dueB ? -1 : 1;
    if (dueA && !dueB) return -1;
    if (!dueA && dueB) return 1;

    return created(b) - created(a);
  });
};

export const listActionItems = async (status?: string | null) => {
  if (status && !STATUSES.has(status.toUpperCase())) {
    throw BadRequest("status must be PENDING or COMPLETED");
  }

  return sortByDueDate(await actionItemRepo.findAll(status?.toUpperCase()));
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
