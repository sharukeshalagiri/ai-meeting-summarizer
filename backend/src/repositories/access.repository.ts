import { prisma } from "../lib/prisma";

/**
 * Owner lookups for access checks (services/account/access.service.ts).
 *
 * Each returns the owning userId, or null when the row does not exist.
 * Kept in their own module, separate from the feature repositories, so
 * every ownership question goes through one small, auditable place.
 */

export const meetingOwnerId = async (meetingId: string) =>
  (
    await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { userId: true },
    })
  )?.userId ?? null;

export const liveSessionOwnerId = async (sessionId: string) =>
  (
    await prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: { meeting: { select: { userId: true } } },
    })
  )?.meeting.userId ?? null;

export const actionItemOwnerId = async (itemId: string) =>
  (
    await prisma.actionItem.findUnique({
      where: { id: itemId },
      select: { meeting: { select: { userId: true } } },
    })
  )?.meeting.userId ?? null;

export const seriesOwnerId = async (seriesId: string) =>
  (
    await prisma.series.findUnique({
      where: { id: seriesId },
      select: { userId: true },
    })
  )?.userId ?? null;

/**
 * A chat thread's owner: its first message's userId, or the owner of
 * the meeting it is about (rows written before accounts). Null when the
 * thread does not exist yet. "legacy" when the thread exists but has no
 * owner at all; nobody may read or extend it.
 */
export const conversationOwnerId = async (
  conversationId: string
): Promise<string | null | "legacy"> => {
  const first = await prisma.chatMessage.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { userId: true, meeting: { select: { userId: true } } },
  });

  if (!first) return null;

  return first.userId ?? first.meeting?.userId ?? "legacy";
};
