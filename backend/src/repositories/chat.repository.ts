import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** All ChatMessage database access. */

export const create = (data: {
  conversationId: string;
  /** Owner of the thread (w4-acct). */
  userId: string;
  meetingId: string | null;
  role: string;
  content: string;
  citations: object[] | null;
}) =>
  prisma.chatMessage.create({
    data: {
      conversationId: data.conversationId,
      userId: data.userId,
      meetingId: data.meetingId,
      role: data.role,
      content: data.content,
      citations: data.citations
        ? (data.citations as Prisma.InputJsonValue)
        : Prisma.DbNull,
    },
  });

/**
 * A thread's messages, only if they are the user's: rows of other users
 * (and ownerless rows from before accounts) never come back.
 */
export const findByConversation = (conversationId: string, userId: string) =>
  prisma.chatMessage.findMany({
    where: {
      conversationId,
      OR: [{ userId }, { userId: null, meeting: { userId } }],
    },
    orderBy: { createdAt: "asc" },
  });

export const deleteConversation = (conversationId: string) =>
  prisma.chatMessage.deleteMany({ where: { conversationId } });
