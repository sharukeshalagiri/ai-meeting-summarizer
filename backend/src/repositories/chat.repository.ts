import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** All ChatMessage database access. */

export const create = (data: {
  conversationId: string;
  meetingId: string | null;
  role: string;
  content: string;
  citations: object[] | null;
}) =>
  prisma.chatMessage.create({
    data: {
      conversationId: data.conversationId,
      meetingId: data.meetingId,
      role: data.role,
      content: data.content,
      citations: data.citations
        ? (data.citations as Prisma.InputJsonValue)
        : Prisma.DbNull,
    },
  });

export const findByConversation = (conversationId: string) =>
  prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });

export const deleteConversation = (conversationId: string) =>
  prisma.chatMessage.deleteMany({ where: { conversationId } });
