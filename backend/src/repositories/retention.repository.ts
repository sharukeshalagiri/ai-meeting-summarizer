import { prisma } from "../lib/prisma";

/** Database access for the audio-retention job (services/retention). */

/**
 * One user's meetings whose recordings the policy now says to delete:
 * processing finished (COMPLETED, no stage running), audio not deleted
 * yet, and, with `olderThan`, created before that instant. A FAILED
 * meeting keeps its audio so the user can still retry it.
 */
export const findAudioToDelete = (input: {
  userId: string;
  olderThan?: Date;
  limit: number;
}) =>
  prisma.meeting.findMany({
    where: {
      userId: input.userId,
      status: "COMPLETED",
      audioDeletedAt: null,
      AND: [
        { OR: [{ processingStage: null }, { processingStage: "DONE" }] },
        { OR: [{ audioPath: { not: null } }, { liveSession: { chunks: { some: {} } } }] },
      ],
      ...(input.olderThan ? { createdAt: { lt: input.olderThan } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: input.limit,
    select: {
      id: true,
      audioPath: true,
      liveSession: { select: { chunks: { select: { path: true } } } },
    },
  });

/**
 * Records that the files are gone. LiveChunk rows stay (their status
 * and results are the idempotency record); their files do not.
 */
export const markAudioDeleted = (meetingId: string, at = new Date()) =>
  prisma.meeting.update({
    where: { id: meetingId },
    data: { audioPath: null, audioDeletedAt: at },
    select: { id: true },
  });
