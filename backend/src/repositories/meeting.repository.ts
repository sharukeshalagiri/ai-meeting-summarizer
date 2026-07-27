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
} satisfies Prisma.MeetingInclude;

/** A meeting with its transcript and summary loaded. */
export type MeetingWithRelations = Prisma.MeetingGetPayload<{
  include: typeof withRelations;
}>;

export const create = (data: {
  title: string;
  description: string | null;
  userId: string;
}) => prisma.meeting.create({ data });

export const findAll = (): Promise<MeetingWithRelations[]> =>
  prisma.meeting.findMany({
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
