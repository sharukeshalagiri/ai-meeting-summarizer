import { prisma } from "../lib/prisma";

/** What an export of one meeting reads (services/export). */
export const findForExport = (meetingId: string) =>
  prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      title: true,
      createdAt: true,
      startedAt: true,
      durationSec: true,
      mode: true,
      series: { select: { name: true } },
      summary: { select: { data: true } },
      actionItems: {
        orderBy: { createdAt: "asc" },
        select: {
          task: true,
          owner: true,
          dueDate: true,
          dueSpoken: true,
          status: true,
          needsReview: true,
        },
      },
      user: { select: { email: true, name: true, displayName: true, timezone: true } },
    },
  });
