import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * All Meeting database access lives here. Services describe intent;
 * this layer owns the query shape, so include-clauses and ordering
 * stay consistent across every caller.
 */

/** Relations the UI always needs alongside a meeting. */
const withRelations = {
  transcript: true,
  summary: true,
  actionItems: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.MeetingInclude;

/** A meeting with its transcript, summary, and action items loaded. */
export type MeetingWithRelations = Prisma.MeetingGetPayload<{
  include: typeof withRelations;
}>;

export const create = (data: {
  title: string;
  description: string | null;
  userId: string;
  source?: string;
  platform?: string | null;
  mode?: string;
}) => prisma.meeting.create({ data });

export const findAll = (): Promise<MeetingWithRelations[]> =>
  prisma.meeting.findMany({
    orderBy: { createdAt: "desc" },
    include: withRelations,
  });

export const findById = (
  id: string
): Promise<MeetingWithRelations | null> =>
  prisma.meeting.findUnique({
    where: { id },
    include: withRelations,
  });

/** Existence check without the cost of loading relations. */
export const exists = async (id: string): Promise<boolean> =>
  (await prisma.meeting.count({ where: { id } })) > 0;

export const updateStatus = (id: string, status: string) =>
  prisma.meeting.update({
    where: { id },
    data: { status },
  });

export const updateAudio = (
  id: string,
  audioPath: string,
  status: string
) =>
  prisma.meeting.update({
    where: { id },
    data: { audioPath, status },
  });

/** Recorded once transcription reveals how long the recording was. */
export const updateDuration = (id: string, durationSec: number) =>
  prisma.meeting.update({
    where: { id },
    data: { durationSec },
  });

export const markStarted = (id: string) =>
  prisma.meeting.update({
    where: { id },
    data: { startedAt: new Date(), status: "LIVE" },
  });

export const markEnded = (id: string, durationSec: number) =>
  prisma.meeting.update({
    where: { id },
    data: { endedAt: new Date(), durationSec },
  });

export const remove = (id: string) =>
  prisma.meeting.delete({ where: { id } });

/* ---------- analytics ---------- */

/**
 * Aggregates used by the dashboard.
 *
 * Kept here rather than in the analytics service so every query
 * against Meeting goes through one layer, and so the aggregation runs
 * in PostgreSQL instead of loading every row into Node.
 */
export const stats = () =>
  prisma.meeting.aggregate({
    _count: { _all: true },
    _sum: { durationSec: true },
    _avg: { durationSec: true },
  });

export const countByStatus = () =>
  prisma.meeting.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

export const countBySource = () =>
  prisma.meeting.groupBy({
    by: ["source"],
    _count: { _all: true },
  });

/** Meetings created since a date, for the frequency chart. */
export const findSince = (since: Date) =>
  prisma.meeting.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      durationSec: true,
      source: true,
    },
  });

/**
 * Summaries with their structured payload, for keyword, topic, and
 * sentiment trends.
 */
export const findSummaryData = (since?: Date) =>
  prisma.summary.findMany({
    where: since ? { meeting: { createdAt: { gte: since } } } : {},
    orderBy: { createdAt: "asc" },
    select: {
      data: true,
      sentiment: true,
      createdAt: true,
      meetingId: true,
      meeting: { select: { title: true, createdAt: true } },
    },
  });
