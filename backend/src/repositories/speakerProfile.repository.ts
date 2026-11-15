import { prisma } from "../lib/prisma";

/**
 * SpeakerProfile access, plus the TranscriptSegment speaker columns
 * (speaker, speakerId) that follow from it (w2-spk).
 *
 * A profile is one voice within one meeting (docs/SCHEMA_NOTES.md):
 * `label` is stable ("Speaker 2", "mic"), `displayName` is the human
 * name once known, `centroid` the running voice embedding.
 */

export const findByMeetingId = (meetingId: string) =>
  prisma.speakerProfile.findMany({
    where: { meetingId },
    orderBy: { label: "asc" },
  });

export const findById = (id: string) =>
  prisma.speakerProfile.findUnique({ where: { id } });

export const findByLabel = (meetingId: string, label: string) =>
  prisma.speakerProfile.findUnique({
    where: { meetingId_label: { meetingId, label } },
  });

export const create = (data: {
  meetingId: string;
  label: string;
  displayName?: string | null;
  centroid?: number[];
  source?: string;
}) =>
  prisma.speakerProfile.create({
    data: {
      meetingId: data.meetingId,
      label: data.label,
      displayName: data.displayName ?? null,
      centroid: data.centroid ?? [],
      source: data.source ?? "DIARIZATION",
    },
  });

export const updateCentroid = (id: string, centroid: number[]) =>
  prisma.speakerProfile.update({ where: { id }, data: { centroid } });

export const setDisplayName = (
  id: string,
  displayName: string | null,
  source?: string
) =>
  prisma.speakerProfile.update({
    where: { id },
    data: { displayName, ...(source ? { source } : {}) },
  });

/**
 * Links segments to their profile by idx after they are written.
 * One transaction, so a chunk is never half-linked.
 */
export const assignSegments = async (
  meetingId: string,
  links: { idx: number; speakerId: string }[]
): Promise<number> => {
  if (links.length === 0) return 0;

  const results = await prisma.$transaction(
    links.map(({ idx, speakerId }) =>
      prisma.transcriptSegment.updateMany({
        where: { meetingId, idx },
        data: { speakerId },
      })
    )
  );

  return results.reduce((total, result) => total + result.count, 0);
};

/** Sets the display label of every segment of one profile. */
export const renameSegmentsOf = async (
  meetingId: string,
  speakerId: string,
  speaker: string
): Promise<number> =>
  (
    await prisma.transcriptSegment.updateMany({
      where: { meetingId, speakerId },
      data: { speaker },
    })
  ).count;

/**
 * Links segments that predate profiles (uploads, text diarization) to
 * a profile by their current label, and renames them in one go.
 */
export const adoptSegmentsByLabel = async (
  meetingId: string,
  label: string,
  speakerId: string,
  speaker: string
): Promise<number> =>
  (
    await prisma.transcriptSegment.updateMany({
      where: { meetingId, speakerId: null, speaker: label },
      data: { speakerId, speaker },
    })
  ).count;

/** idx values of one profile's segments (Correction before/after). */
export const segmentIdxOf = async (
  meetingId: string,
  speakerId: string
): Promise<number[]> =>
  (
    await prisma.transcriptSegment.findMany({
      where: { meetingId, speakerId },
      select: { idx: true },
      orderBy: { idx: "asc" },
    })
  ).map((row) => row.idx);
