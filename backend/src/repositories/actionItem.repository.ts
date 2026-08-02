import { prisma } from "../lib/prisma";
import type { ActionItem } from "../types/summary";

/** All ActionItem database access. */

export const findByMeetingId = (meetingId: string) =>
  prisma.actionItem.findMany({
    where: { meetingId },
    orderBy: [{ createdAt: "asc" }],
  });

/**
 * Every action item across meetings, newest meeting first.
 *
 * Includes the parent meeting so the task board can link back without
 * a second round trip per row.
 */
export const findAll = (status?: string) =>
  prisma.actionItem.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      meeting: { select: { id: true, title: true, createdAt: true } },
    },
  });

export const findById = (id: string) =>
  prisma.actionItem.findUnique({ where: { id } });

export const updateStatus = (
  id: string,
  status: string,
  completedAt: Date | null
) =>
  prisma.actionItem.update({
    where: { id },
    data: { status, completedAt },
  });

/**
 * Replaces a meeting's action items with the ones a fresh summary
 * produced.
 *
 * Re-summarizing regenerates the list, so the old rows are dropped in
 * the same transaction to avoid duplicating tasks. Completion state
 * for a task the model re-emits is preserved by matching on the task
 * text, which is the only stable identifier available.
 */
export const replaceForMeeting = async (
  meetingId: string,
  items: ActionItem[]
): Promise<number> => {
  const previous = await prisma.actionItem.findMany({
    where: { meetingId },
    select: { task: true, status: true, completedAt: true },
  });

  const previousByTask = new Map(
    previous.map((item) => [item.task.trim().toLowerCase(), item])
  );

  const [, created] = await prisma.$transaction([
    prisma.actionItem.deleteMany({ where: { meetingId } }),

    prisma.actionItem.createMany({
      data: items.map((item) => {
        const carried = previousByTask.get(
          item.task.trim().toLowerCase()
        );

        return {
          meetingId,
          task: item.task,
          owner: item.owner,
          dueDate: item.dueDate,
          priority: item.priority,
          status: carried?.status ?? "PENDING",
          completedAt: carried?.completedAt ?? null,
        };
      }),
    }),
  ]);

  return created.count;
};

/** Counts by status across every meeting, for the analytics tiles. */
export const countByStatus = () =>
  prisma.actionItem.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

export const countAll = () => prisma.actionItem.count();

/** Open items grouped by owner, so the dashboard can show a workload. */
export const countOpenByOwner = () =>
  prisma.actionItem.groupBy({
    by: ["owner"],
    where: { status: "PENDING", owner: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { owner: "desc" } },
    take: 10,
  });
