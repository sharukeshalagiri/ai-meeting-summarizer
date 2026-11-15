import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { toJsonValueV2 } from "../types/summary";
import { DEMO_EMAIL, DEMO_NAME, type DemoMeeting } from "./types";

/**
 * The only database access of demo mode (w5-demo): find the demo
 * account, replace its meetings with the seed, and keyword search its
 * segments (the demo never calls Gemini, so it has no embeddings).
 */

const publicUser = { id: true, name: true, email: true } as const;

export const findDemoUser = () => prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: publicUser });

/** The newest demo meeting, where "Try the demo" lands. */
export const firstMeetingId = async (userId: string): Promise<string | null> =>
  (await prisma.meeting.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ??
  null;

export interface SeedMeeting extends DemoMeeting {
  /** Meeting.audioPath (relative to the backend's working directory). */
  audioPath: string | null;
  /** The summary's Markdown rendering (Summary.content). */
  markdown: string;
}

/**
 * Creates the demo account if needed and replaces all of its meetings,
 * in one transaction, so a re-seed never leaves a half-built demo. The
 * account never has a password (it is reachable only through the demo
 * sign-in) and keeps its audio (retention KEEP).
 */
export const replaceDemoData = async (meetings: SeedMeeting[]) =>
  prisma.$transaction(
    async (tx) => {
      const user = await tx.user.upsert({
        where: { email: DEMO_EMAIL },
        create: { email: DEMO_EMAIL, name: DEMO_NAME, audioRetention: "KEEP" },
        update: { name: DEMO_NAME, passwordHash: null, audioRetention: "KEEP", audioRetentionDays: null },
        select: publicUser,
      });

      await tx.meeting.deleteMany({ where: { userId: user.id } });
      await tx.chatMessage.deleteMany({ where: { userId: user.id } });

      const ids: Record<string, string> = {};
      for (const meeting of meetings) {
        ids[meeting.key] = await createMeeting(tx, user.id, meeting);
      }

      return { user, ids };
    },
    { timeout: 60_000 }
  );

const createMeeting = async (tx: Prisma.TransactionClient, userId: string, m: SeedMeeting): Promise<string> => {
  const meeting = await tx.meeting.create({
    data: {
      userId,
      title: m.title,
      description: m.description,
      status: "COMPLETED",
      source: "UPLOAD",
      mode: m.mode,
      audioPath: m.audioPath,
      durationSec: m.durationSec,
      startedAt: m.createdAt,
      endedAt: new Date(m.createdAt.getTime() + m.durationSec * 1000),
      createdAt: m.createdAt,
      processingStage: "DONE",
      processingProgress: 100,
      transcript: { create: { content: m.transcriptText, createdAt: m.createdAt } },
      summary: {
        create: {
          content: m.markdown,
          data: toJsonValueV2(m.summary),
          sentiment: m.summary.sentiment.overall,
        },
      },
    },
    select: { id: true },
  });

  const profiles = new Map<string, string>();
  for (const speaker of m.speakers) {
    const profile = await tx.speakerProfile.create({
      data: { meetingId: meeting.id, label: speaker.label, displayName: speaker.displayName, source: "DIARIZATION" },
      select: { id: true },
    });
    profiles.set(speaker.label, profile.id);
  }

  await tx.transcriptSegment.createMany({
    data: m.segments.map((s) => ({
      meetingId: meeting.id,
      idx: s.idx,
      speaker: s.speaker,
      text: s.text,
      startMs: s.startMs,
      endMs: s.endMs,
      channel: s.channel,
      noiseLabel: s.noiseLabel,
      speakerId: profiles.get(s.speakerLabel) ?? null,
    })),
  });

  // A meeting's items are listed by createdAt: 1 ms apart keeps the
  // summary's order.
  for (const [i, item] of m.actionItems.entries()) {
    await tx.actionItem.create({
      data: {
        meetingId: meeting.id,
        task: item.task,
        owner: item.owner,
        assignedBy: item.assignedBy,
        dueSpoken: item.dueSpoken,
        dueDate: item.dueDate,
        priority: item.priority,
        status: item.status,
        completedAt: item.status === "COMPLETED" ? m.createdAt : null,
        confidence: item.confidence,
        needsReview: item.needsReview,
        evidence: item.evidence as unknown as Prisma.InputJsonValue,
        createdAt: new Date(m.createdAt.getTime() + i),
      },
    });
  }

  return meeting.id;
};

export interface SegmentHit {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: Date;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** Segments of the user's meetings containing any of the terms. */
export const findSegmentsContaining = async (
  userId: string,
  terms: string[],
  meetingId: string | null,
  take: number
): Promise<SegmentHit[]> => {
  const rows = await prisma.transcriptSegment.findMany({
    where: {
      meeting: { userId, ...(meetingId ? { id: meetingId } : {}) },
      OR: terms.map((term) => ({ text: { contains: term, mode: "insensitive" as const } })),
    },
    orderBy: [{ meetingId: "asc" }, { idx: "asc" }],
    take,
    select: {
      id: true,
      meetingId: true,
      speaker: true,
      text: true,
      startMs: true,
      endMs: true,
      meeting: { select: { title: true, createdAt: true } },
    },
  });

  return rows.map((row) => ({
    segmentId: row.id,
    meetingId: row.meetingId,
    meetingTitle: row.meeting.title,
    meetingCreatedAt: row.meeting.createdAt,
    speaker: row.speaker,
    text: row.text,
    startMs: row.startMs,
    endMs: row.endMs,
  }));
};
