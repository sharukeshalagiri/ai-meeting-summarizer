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

/** One user's meetings (every list is scoped by owner). */
export const findAll = (userId: string): Promise<MeetingWithRelations[]> =>
  prisma.meeting.findMany({
    where: { userId },
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

/** Meeting.mode, written when the user picks a mode (PATCH /mode). */
export const updateMode = (id: string, mode: string) =>
  prisma.meeting.update({
    where: { id },
    data: { mode },
  });

/**
 * Background-processing state (processingStage / Progress / Error).
 * Only the fields passed are written; `error: null` clears it.
 */
export const updateProcessing = (
  id: string,
  data: {
    stage?: string | null;
    progress?: number | null;
    error?: string | null;
    status?: string;
  }
) =>
  prisma.meeting.update({
    where: { id },
    data: {
      ...(data.stage !== undefined ? { processingStage: data.stage } : {}),
      ...(data.progress !== undefined
        ? { processingProgress: data.progress }
        : {}),
      ...(data.error !== undefined ? { processingError: data.error } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    },
  });

/** The columns the progress stream (SSE) sends; no relations. */
export const findProgress = (id: string) =>
  prisma.meeting.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      source: true,
      processingStage: true,
      processingProgress: true,
      processingError: true,
    },
  });

export type MeetingProgress = NonNullable<Awaited<ReturnType<typeof findProgress>>>;

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
export const stats = (userId: string) =>
  prisma.meeting.aggregate({
    where: { userId },
    _count: { _all: true },
    _sum: { durationSec: true },
    _avg: { durationSec: true },
  });

export const countByStatus = (userId: string) =>
  prisma.meeting.groupBy({
    by: ["status"],
    where: { userId },
    _count: { _all: true },
  });

export const countBySource = (userId: string) =>
  prisma.meeting.groupBy({
    by: ["source"],
    where: { userId },
    _count: { _all: true },
  });

/** Meetings created since a date, for the frequency chart. */
export const findSince = (userId: string, since: Date) =>
  prisma.meeting.findMany({
    where: { userId, createdAt: { gte: since } },
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
export const findSummaryData = (userId: string, since?: Date) =>
  prisma.summary.findMany({
    where: { meeting: { userId, ...(since ? { createdAt: { gte: since } } : {}) } },
    orderBy: { createdAt: "asc" },
    select: {
      data: true,
      sentiment: true,
      createdAt: true,
      meetingId: true,
      meeting: { select: { title: true, createdAt: true } },
    },
  });
