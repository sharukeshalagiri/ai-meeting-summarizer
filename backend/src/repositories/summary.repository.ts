import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** All Summary database access. */

export const findByMeetingId = (meetingId: string) =>
  prisma.summary.findUnique({ where: { meetingId } });

/**
 * `content` holds the markdown rendering and `data` the structured
 * object; both are written together so they cannot drift apart.
 */
export const upsert = (
  meetingId: string,
  content: string,
  data: Prisma.InputJsonObject
) =>
  prisma.summary.upsert({
    where: { meetingId },
    update: { content, data },
    create: { meetingId, content, data },
  });
