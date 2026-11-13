import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** All LiveChunk database access (capture contract chunks). */

export const findBySeq = (sessionId: string, seq: number) =>
  prisma.liveChunk.findUnique({
    where: { sessionId_seq: { sessionId, seq } },
  });

/**
 * Claims (sessionId, seq). Returns null when the row already exists, so
 * two concurrent uploads of the same chunk cannot both process it: the
 * unique index decides the winner.
 */
export const claim = async (data: {
  sessionId: string;
  seq: number;
  path: string;
  startOffsetMs: number;
  durationMs: number;
  channelLayout: string;
}) => {
  try {
    return await prisma.liveChunk.create({
      data: { ...data, status: "PROCESSING" },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return null;
    }

    throw error;
  }
};

/**
 * Re-claims a FAILED chunk for a retry. Only succeeds if it is still
 * FAILED, so concurrent retries cannot both proceed.
 */
export const reclaimFailed = async (
  id: string,
  data: {
    path: string;
    startOffsetMs: number;
    durationMs: number;
    channelLayout: string;
  }
): Promise<boolean> => {
  const result = await prisma.liveChunk.updateMany({
    where: { id, status: "FAILED" },
    data: { ...data, status: "PROCESSING", error: null },
  });

  return result.count === 1;
};

export const markTranscribed = (
  id: string,
  segmentCount: number,
  result: Prisma.InputJsonObject
) =>
  prisma.liveChunk.update({
    where: { id },
    data: { status: "TRANSCRIBED", segmentCount, result },
  });

export const markFailed = (id: string, error: string) =>
  prisma.liveChunk.update({
    where: { id },
    data: { status: "FAILED", error: error.slice(0, 1000) },
  });
