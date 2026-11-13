import { prisma } from "../lib/prisma";
import type { DiarizedSegment } from "../types/segment";

/** All TranscriptSegment database access. */

export const findByMeetingId = (meetingId: string) =>
  prisma.transcriptSegment.findMany({
    where: { meetingId },
    orderBy: { idx: "asc" },
  });

export const countByMeetingId = (meetingId: string) =>
  prisma.transcriptSegment.count({ where: { meetingId } });

/**
 * Replaces a meeting's segments in one transaction.
 *
 * Re-running transcription must not leave a mix of old and new rows,
 * and `idx` is unique per meeting, so a partial write would collide on
 * the next attempt.
 */
export const replaceForMeeting = (
  meetingId: string,
  segments: DiarizedSegment[]
) =>
  prisma.$transaction([
    prisma.transcriptSegment.deleteMany({ where: { meetingId } }),

    prisma.transcriptSegment.createMany({
      data: segments.map((segment, idx) => ({
        meetingId,
        idx,
        speaker: segment.speaker,
        text: segment.text,
        startMs: segment.startMs,
        endMs: segment.endMs,
      })),
    }),
  ]);

/**
 * Appends segments to a live meeting, continuing the existing index.
 *
 * Live capture arrives chunk by chunk, so segments accumulate rather
 * than being replaced wholesale.
 */
export const appendForMeeting = async (
  meetingId: string,
  segments: DiarizedSegment[]
): Promise<number> => {
  if (segments.length === 0) return 0;

  const existing = await countByMeetingId(meetingId);

  const result = await prisma.transcriptSegment.createMany({
    data: segments.map((segment, offset) => ({
      meetingId,
      idx: existing + offset,
      speaker: segment.speaker,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
  });

  return result.count;
};

/**
 * Inserts segments at explicit idx values (capture-contract chunks use
 * seq * 1000 + i). Existing idx values are skipped rather than failing,
 * so a retried chunk cannot duplicate segments.
 */
export const insertAtIdx = async (
  meetingId: string,
  segments: (DiarizedSegment & { idx: number })[]
): Promise<number> => {
  if (segments.length === 0) return 0;

  const result = await prisma.transcriptSegment.createMany({
    data: segments.map((segment) => ({
      meetingId,
      idx: segment.idx,
      speaker: segment.speaker,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
    skipDuplicates: true,
  });

  return result.count;
};

/** Most recent segments, used as context for a rolling summary. */
export const findRecentByMeetingId = async (
  meetingId: string,
  limit: number
) => {
  const rows = await prisma.transcriptSegment.findMany({
    where: { meetingId },
    orderBy: { idx: "desc" },
    take: limit,
  });

  return rows.reverse();
};

/** Segments with no embedding yet, for the indexing pass. */
export const findWithoutEmbedding = (meetingId: string) =>
  prisma.transcriptSegment.findMany({
    where: { meetingId, embedding: { is: null } },
    orderBy: { idx: "asc" },
  });
