import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * All Correction database access.
 *
 * A correction records a user's fix to model output (a speaker rename,
 * an edited action item) as before/after JSON. Segment references inside
 * before/after use TranscriptSegment.idx, never array positions.
 */

export const record = (input: {
  meetingId: string;
  /** e.g. SPEAKER, TRANSCRIPT_TEXT, ACTION_ITEM, SUMMARY_ITEM */
  kind: string;
  targetId?: string | null;
  before: Prisma.InputJsonValue;
  after: Prisma.InputJsonValue;
}) =>
  prisma.correction.create({
    data: {
      meetingId: input.meetingId,
      kind: input.kind,
      targetId: input.targetId ?? null,
      before: input.before,
      after: input.after,
    },
  });

export const findByMeetingId = (meetingId: string) =>
  prisma.correction.findMany({
    where: { meetingId },
    orderBy: { createdAt: "asc" },
  });
