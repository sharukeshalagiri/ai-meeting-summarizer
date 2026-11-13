import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** All LiveSession and RollingSummary database access. */

const withRolling = {
  rollingSummaries: { orderBy: { atMs: "asc" } },
} satisfies Prisma.LiveSessionInclude;

export type LiveSessionWithRolling = Prisma.LiveSessionGetPayload<{
  include: typeof withRolling;
}>;

export const create = (data: {
  meetingId: string;
  platform: string | null;
  source?: string | null;
  hints?: string[];
}) => prisma.liveSession.create({ data });

/** Replaces the participant names the recorder reported. */
export const setRoster = (id: string, roster: string[]) =>
  prisma.liveSession.update({
    where: { id },
    data: { roster },
  });

/**
 * Records a capture-contract chunk. Chunks can arrive out of order, so
 * elapsedMs only ever moves forward to the furthest chunk end seen,
 * using GREATEST in one statement so concurrent chunks cannot regress it.
 */
export const recordContractChunk = async (id: string, endMs: number) => {
  await prisma.$executeRaw`
    UPDATE "LiveSession"
    SET "chunkCount" = "chunkCount" + 1,
        "elapsedMs" = GREATEST("elapsedMs", ${Math.round(endMs)}),
        "lastChunkAt" = NOW()
    WHERE "id" = ${id}`;

  return prisma.liveSession.findUniqueOrThrow({ where: { id } });
};

export const findById = (id: string) =>
  prisma.liveSession.findUnique({ where: { id } });

export const findByMeetingId = (
  meetingId: string
): Promise<LiveSessionWithRolling | null> =>
  prisma.liveSession.findUnique({
    where: { meetingId },
    include: withRolling,
  });

export const findActiveByMeetingId = (meetingId: string) =>
  prisma.liveSession.findFirst({
    where: { meetingId, status: "ACTIVE" },
  });

/**
 * Advances the session by one chunk.
 *
 * `elapsedMs` is incremented rather than set so concurrent chunk
 * uploads cannot overwrite each other's progress.
 */
export const recordChunk = (id: string, durationMs: number) =>
  prisma.liveSession.update({
    where: { id },
    data: {
      chunkCount: { increment: 1 },
      elapsedMs: { increment: durationMs },
      lastChunkAt: new Date(),
    },
  });

/** Marks the point at which a rolling summary was last produced. */
export const markRollingAt = (id: string, atMs: number) =>
  prisma.liveSession.update({
    where: { id },
    data: { lastRollingAtMs: atMs },
  });

export const end = (id: string) =>
  prisma.liveSession.update({
    where: { id },
    data: { status: "ENDED", endedAt: new Date() },
  });

export const addRollingSummary = (
  sessionId: string,
  atMs: number,
  data: Prisma.InputJsonObject
) =>
  prisma.rollingSummary.create({
    data: { sessionId, atMs, data },
  });

export const findRollingSummaries = (sessionId: string) =>
  prisma.rollingSummary.findMany({
    where: { sessionId },
    orderBy: { atMs: "asc" },
  });

/**
 * Sessions whose capture stopped sending chunks.
 *
 * A browser tab can close without reaching the stop endpoint, which
 * would otherwise leave a session ACTIVE forever.
 */
export const findStale = (cutoff: Date) =>
  prisma.liveSession.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { lastChunkAt: { lt: cutoff } },
        { lastChunkAt: null, startedAt: { lt: cutoff } },
      ],
    },
  });
