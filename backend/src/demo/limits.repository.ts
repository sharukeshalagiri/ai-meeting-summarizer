import { prisma } from "../lib/prisma";

/**
 * Lookups for the public-instance duration caps
 * (middleware/rateLimit.middleware.ts). Kept apart from the demo seed's
 * repository so a cap check loads one column, not a meeting.
 */

export const meetingAudioPath = async (meetingId: string): Promise<string | null> =>
  (await prisma.meeting.findUnique({ where: { id: meetingId }, select: { audioPath: true } }))?.audioPath ?? null;

export const liveSessionElapsedMs = async (sessionId: string): Promise<number | null> =>
  (await prisma.liveSession.findUnique({ where: { id: sessionId }, select: { elapsedMs: true } }))?.elapsedMs ?? null;
