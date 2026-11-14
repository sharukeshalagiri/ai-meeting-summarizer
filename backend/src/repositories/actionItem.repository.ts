import { Prisma } from "@prisma/client";
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
 * a second round trip per row. The service re-sorts by due date.
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
 * An action item to store. The fields beyond the v1 four are filled by
 * the v2 summary pipeline; v1 callers leave them out.
 */
export type ActionItemInput = ActionItem & {
  dueSpoken?: string | null;
  assignedBy?: string | null;
  confidence?: number | null;
  /** [{ idx, speaker, startMs }] with TranscriptSegment.idx. */
  evidence?: Prisma.InputJsonValue | null;
  needsReview?: boolean;
};

export interface ReplaceOptions {
  /**
   * Rows a human accepted or edited. They survive re-summarizing, and a
   * regenerated item with the same task text is skipped so it does not
   * reappear as a duplicate.
   */
  keepIds?: string[];
  /** Task texts a human rejected or replaced; never re-created. */
  suppressTasks?: string[];
}

export const normalizeTask = (task: string) =>
  task.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Replaces a meeting's action items with the ones a fresh summary
 * produced.
 *
 * Re-summarizing regenerates the list, so the old rows are dropped in
 * the same transaction to avoid duplicating tasks. Completion state
 * for a task the model re-emits is preserved by matching on the task
 * text, which is the only stable identifier available. Rows listed in
 * `keepIds` (human-reviewed) are left untouched.
 */
export const replaceForMeeting = async (
  meetingId: string,
  items: ActionItemInput[],
  options: ReplaceOptions = {}
): Promise<number> => {
  const keepIds = options.keepIds ?? [];

  const previous = await prisma.actionItem.findMany({
    where: { meetingId },
    select: { id: true, task: true, status: true, completedAt: true },
  });

  const previousByTask = new Map(
    previous.map((item) => [normalizeTask(item.task), item])
  );

  const blocked = new Set([
    ...previous
      .filter((item) => keepIds.includes(item.id))
      .map((item) => normalizeTask(item.task)),
    ...(options.suppressTasks ?? []).map(normalizeTask),
  ]);

  const fresh = items.filter(
    (item) => !blocked.has(normalizeTask(item.task))
  );

  const [, created] = await prisma.$transaction([
    prisma.actionItem.deleteMany({
      where: { meetingId, id: { notIn: keepIds } },
    }),

    prisma.actionItem.createMany({
      data: fresh.map((item) => {
        const carried = previousByTask.get(normalizeTask(item.task));

        return {
          meetingId,
          task: item.task,
          owner: item.owner,
          dueDate: item.dueDate,
          priority: item.priority,
          dueSpoken: item.dueSpoken ?? null,
          assignedBy: item.assignedBy ?? null,
          confidence: item.confidence ?? null,
          evidence: item.evidence ?? Prisma.DbNull,
          needsReview: item.needsReview ?? false,
          status: carried?.status ?? "PENDING",
          completedAt: carried?.completedAt ?? null,
        };
      }),
    }),
  ]);

  return created.count;
};

/** Applies a human review (accept or edit) to one row. */
export const updateReviewed = (
  id: string,
  data: {
    task?: string;
    owner?: string | null;
    dueSpoken?: string | null;
    dueDate?: string | null;
    priority?: string;
  }
) =>
  prisma.actionItem.update({
    where: { id },
    data: { ...data, needsReview: false },
  });

export const deleteById = (id: string) =>
  prisma.actionItem.delete({ where: { id } });

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
