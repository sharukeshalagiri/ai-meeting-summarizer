import { prisma } from "../lib/prisma";

/**
 * All Series database access. Every query takes the owner's userId, so
 * a series id from another account matches nothing.
 *
 * Meetings in a series are ordered by createdAt: it is always set, and
 * for both uploads and live captures it is when the meeting happened
 * (or was recorded) closely enough to order a weekly series.
 */

export const findByUser = (userId: string) =>
  prisma.series.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { meetings: true } },
      meetings: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, title: true, createdAt: true },
      },
    },
  });

export const findOwned = (id: string, userId: string) =>
  prisma.series.findFirst({ where: { id, userId } });

export const findByName = (userId: string, name: string) =>
  prisma.series.findUnique({ where: { userId_name: { userId, name } } });

export const create = (userId: string, name: string) =>
  prisma.series.create({ data: { userId, name } });

export const rename = (id: string, userId: string, name: string) =>
  prisma.series.updateMany({ where: { id, userId }, data: { name } });

export const setMeetingSeries = (
  meetingId: string,
  userId: string,
  seriesId: string | null
) =>
  prisma.meeting.updateMany({
    where: { id: meetingId, userId },
    data: { seriesId },
  });

/** A series' meetings, oldest first, with what the Prep view needs. */
export const findMeetings = (seriesId: string, userId: string) =>
  prisma.meeting.findMany({
    where: { seriesId, userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      startedAt: true,
      status: true,
      summary: { select: { data: true } },
    },
  });

/** The meeting's series and when it happened. */
export const findMeetingPlace = (meetingId: string) =>
  prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, userId: true, seriesId: true, createdAt: true },
  });

/**
 * Open action items from meetings earlier in the series than `before`,
 * newest first. "Earlier" is by createdAt; the meeting itself is
 * excluded by id as well, in case two share a timestamp.
 */
export const findEarlierOpenItems = (input: {
  seriesId: string;
  userId: string;
  meetingId: string;
  before: Date;
  limit: number;
}) =>
  prisma.actionItem.findMany({
    where: {
      status: "PENDING",
      meeting: {
        seriesId: input.seriesId,
        userId: input.userId,
        id: { not: input.meetingId },
        createdAt: { lte: input.before },
      },
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    select: {
      id: true,
      task: true,
      owner: true,
      dueDate: true,
      dueSpoken: true,
      createdAt: true,
      meeting: { select: { id: true, title: true, createdAt: true } },
    },
  });

/** Every open item in a series (Prep view). */
export const findOpenItems = (seriesId: string, userId: string) =>
  prisma.actionItem.findMany({
    where: { status: "PENDING", meeting: { seriesId, userId } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      task: true,
      owner: true,
      dueDate: true,
      dueSpoken: true,
      needsReview: true,
      meeting: { select: { id: true, title: true, createdAt: true } },
    },
  });

export const meetingIdsInSeries = async (seriesId: string, userId: string) =>
  (
    await prisma.meeting.findMany({
      where: { seriesId, userId },
      select: { id: true },
    })
  ).map((row) => row.id);
