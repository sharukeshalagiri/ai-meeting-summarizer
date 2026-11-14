import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { DiarizedSegment } from "../types/segment";

/** All TranscriptSegment database access. */

/**
 * Columns shared by every segment writer. `channel` and `words` are
 * only present when the ASR provider returned them (docs/SCHEMA_NOTES.md),
 * so older providers keep writing null / DB-null.
 */
export const segmentColumns = (segment: DiarizedSegment) => ({
  speaker: segment.speaker,
  text: segment.text,
  startMs: segment.startMs,
  endMs: segment.endMs,
  channel: segment.channel ?? null,
  words: segment.words?.length
    ? (segment.words as unknown as Prisma.InputJsonValue)
    : Prisma.DbNull,
});

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
        ...segmentColumns(segment),
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
      ...segmentColumns(segment),
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
      ...segmentColumns(segment),
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

/**
 * Segments with from <= idx < to. Live capture uses it to read the
 * previous chunk (idx seq*1000 .. seq*1000+999), which stays correct when
 * chunks arrive out of order, unlike "the most recent N segments".
 */
export const findByIdxRange = (
  meetingId: string,
  from: number,
  to: number
) =>
  prisma.transcriptSegment.findMany({
    where: { meetingId, idx: { gte: from, lt: to } },
    orderBy: { idx: "asc" },
  });

/**
 * Stores the summary pipeline's CLEAN labels (TranscriptSegment.noiseLabel),
 * keyed by idx, in one transaction so a summary run never leaves half
 * its labels written. (meetingId, idx) is the segment's unique key; the
 * schema has no transcriptId on segments. updateMany, not update, so an
 * idx that no longer exists (re-transcribed meanwhile) is skipped
 * rather than failing the batch.
 */
export const setNoiseLabels = async (
  meetingId: string,
  labels: { idx: number; label: string }[]
): Promise<number> => {
  if (labels.length === 0) return 0;

  const results = await prisma.$transaction(
    labels.map(({ idx, label }) =>
      prisma.transcriptSegment.updateMany({
        where: { meetingId, idx },
        data: { noiseLabel: label },
      })
    )
  );

  return results.reduce((total, result) => total + result.count, 0);
};
