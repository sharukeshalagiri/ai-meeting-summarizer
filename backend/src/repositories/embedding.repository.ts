import { prisma } from "../lib/prisma";

/**
 * Vector storage and similarity search.
 *
 * This deployment's PostgreSQL has no pgvector extension available, so
 * embeddings live in a float8[] column and cosine similarity is
 * computed in SQL. Vectors are unit-normalized on write, which reduces
 * cosine similarity to a plain dot product and keeps the expression
 * cheap enough to run over a meeting archive.
 *
 * The query is a sequential scan, which is the right trade at this
 * scale (thousands of segments, single-digit milliseconds). Swapping in
 * pgvector later means changing the column type and this one function;
 * nothing above this layer knows the difference. See docs/DECISIONS.md.
 */

export interface SearchHit {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: Date;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  score: number;
}

export const upsertMany = async (
  rows: {
    segmentId: string;
    meetingId: string;
    embedding: number[];
    model: string;
  }[]
): Promise<number> => {
  if (rows.length === 0) return 0;

  // createMany cannot upsert, and re-indexing should overwrite rather
  // than collide on the primary key.
  await prisma.segmentEmbedding.deleteMany({
    where: { segmentId: { in: rows.map((row) => row.segmentId) } },
  });

  const result = await prisma.segmentEmbedding.createMany({
    data: rows.map((row) => ({
      segmentId: row.segmentId,
      meetingId: row.meetingId,
      embedding: row.embedding,
      model: row.model,
      dims: row.embedding.length,
    })),
  });

  return result.count;
};

export const countForMeeting = (meetingId: string) =>
  prisma.segmentEmbedding.count({ where: { meetingId } });

export const countAll = () => prisma.segmentEmbedding.count();

export const deleteForMeeting = (meetingId: string) =>
  prisma.segmentEmbedding.deleteMany({ where: { meetingId } });

/**
 * Nearest segments to a query vector.
 *
 * `minScore` filters out weak matches so an unrelated question returns
 * nothing rather than the least-bad segment in the archive.
 */
export const search = async (input: {
  embedding: number[];
  limit: number;
  meetingId?: string | null;
  minScore?: number;
}): Promise<SearchHit[]> => {
  const { embedding, limit, meetingId, minScore = 0.35 } = input;

  if (embedding.length === 0) return [];

  // The vector is interpolated as a literal rather than bound: node-
  // postgres sends a JS number[] as a text array, which PostgreSQL
  // will not implicitly cast to float8[] inside unnest(). The values
  // are model output, so they are finite numbers by construction, and
  // they are re-validated here before reaching the query.
  const literal = `ARRAY[${embedding
    .map((value) => {
      if (!Number.isFinite(value)) {
        throw new Error("Embedding contains a non-finite value");
      }

      return value.toFixed(8);
    })
    .join(",")}]::float8[]`;

  const rows = await prisma.$queryRawUnsafe<
    (Omit<SearchHit, "score"> & { score: number })[]
  >(
    `
    SELECT
      e."segmentId"       AS "segmentId",
      e."meetingId"       AS "meetingId",
      m."title"           AS "meetingTitle",
      m."createdAt"       AS "meetingCreatedAt",
      s."speaker"         AS "speaker",
      s."text"            AS "text",
      s."startMs"         AS "startMs",
      s."endMs"           AS "endMs",
      (
        SELECT COALESCE(SUM(a * b), 0)
        FROM unnest(e."embedding", ${literal}) AS t(a, b)
      )                   AS "score"
    FROM "SegmentEmbedding" e
    JOIN "TranscriptSegment" s ON s."id" = e."segmentId"
    JOIN "Meeting" m           ON m."id" = e."meetingId"
    WHERE ($1::text IS NULL OR e."meetingId" = $1::text)
      AND e."dims" = $2::int
    ORDER BY "score" DESC
    LIMIT $3::int
    `,
    meetingId ?? null,
    embedding.length,
    limit
  );

  return rows
    .map((row) => ({ ...row, score: Number(row.score) }))
    .filter((row) => row.score >= minScore);
};
