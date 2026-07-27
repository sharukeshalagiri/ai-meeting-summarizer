import { prisma } from "../lib/prisma";

/** All Transcript database access. */

export const findByMeetingId = (meetingId: string) =>
  prisma.transcript.findUnique({ where: { meetingId } });

export const findAll = () =>
  prisma.transcript.findMany({
    include: { meeting: true },
    orderBy: { createdAt: "desc" },
  });

export const create = (data: { meetingId: string; content: string }) =>
  prisma.transcript.create({ data });

/** Re-running transcription replaces the previous result. */
export const upsert = (meetingId: string, content: string) =>
  prisma.transcript.upsert({
    where: { meetingId },
    update: { content },
    create: { meetingId, content },
  });
