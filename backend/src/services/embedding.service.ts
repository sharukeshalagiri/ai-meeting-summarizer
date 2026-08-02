import { env } from "../lib/env";
import { getClient, toGeminiError, withRetry } from "../lib/gemini";
import { logger } from "../lib/logger";
import * as embeddingRepo from "../repositories/embedding.repository";
import * as segmentRepo from "../repositories/segment.repository";

const log = logger.child({ module: "embedding.service" });

/**
 * Turns transcript segments into vectors for semantic search.
 *
 * Segments are embedded rather than whole transcripts so a search can
 * point at the moment something was said, which is what makes a
 * citation useful.
 */

/**
 * Segments per embed call. The API accepts a batch, and a meeting can
 * produce hundreds of segments, so batching keeps indexing to a
 * handful of round trips.
 */
const BATCH_SIZE = 64;

/**
 * Scales a vector to unit length so cosine similarity becomes a dot
 * product. A zero vector would divide by zero, so it is passed through
 * unchanged and filtered out by the score threshold at search time.
 */
const normalize = (values: number[]): number[] => {
  let sumOfSquares = 0;

  for (const value of values) {
    sumOfSquares += value * value;
  }

  const magnitude = Math.sqrt(sumOfSquares);

  return magnitude > 0
    ? values.map((value) => value / magnitude)
    : values;
};

const readEmbeddings = (
  response: { embeddings?: { values?: number[] }[] },
  expected: number
): number[][] => {
  const embeddings = response.embeddings ?? [];

  if (embeddings.length !== expected) {
    throw new Error(
      `Embedding service returned ${embeddings.length} vectors for ` +
        `${expected} inputs.`
    );
  }

  return embeddings.map((entry) => {
    const values = entry.values;

    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("Embedding service returned an empty vector.");
    }

    return normalize(values);
  });
};

/**
 * Embeds a batch of texts.
 *
 * `taskType` matters: Gemini embeds a stored passage and a search
 * query into deliberately different regions, so indexing and querying
 * must declare which they are.
 *
 * Each text is wrapped as its own Content. Passing a plain string
 * array instead makes the SDK read the whole array as the parts of a
 * single document, which silently returns one vector for the batch
 * rather than one per segment.
 */
const embedBatch = async (
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
): Promise<number[][]> => {
  const response = await withRetry(() =>
    getClient().models.embedContent({
      model: env.embeddingModel,

      contents: texts.map((text) => ({
        role: "user",
        parts: [{ text }],
      })),

      config: {
        taskType,
        // Full-width vectors are 3072 floats per segment, which is a
        // lot of storage and arithmetic for a similarity scan. Google
        // supports truncating, and the result is re-normalized below,
        // which truncation requires.
        outputDimensionality: env.embeddingDims,
      },
    })
  );

  return readEmbeddings(response, texts.length);
};

/** Embeds a single search query. */
export const embedQuery = async (query: string): Promise<number[]> => {
  try {
    const [vector] = await embedBatch([query], "RETRIEVAL_QUERY");

    return vector ?? [];
  } catch (error) {
    throw toGeminiError(
      error,
      "Could not run that search right now. Please try again."
    );
  }
};

/**
 * Embeds every segment of a meeting that is not indexed yet.
 *
 * Incremental by design: live capture appends segments continuously,
 * and re-embedding the whole meeting on each chunk would waste quota.
 */
export const indexMeeting = async (
  meetingId: string
): Promise<number> => {
  const pending = await segmentRepo.findWithoutEmbedding(meetingId);

  if (pending.length === 0) return 0;

  const startedAt = Date.now();

  let indexed = 0;

  try {
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const batch = pending.slice(start, start + BATCH_SIZE);

      // Speaker and text together: "who said it" is often the point of
      // the question ("what did Sarah say about auth?").
      const vectors = await embedBatch(
        batch.map(
          (segment) => `${segment.speaker}: ${segment.text}`
        ),
        "RETRIEVAL_DOCUMENT"
      );

      indexed += await embeddingRepo.upsertMany(
        batch.map((segment, offset) => ({
          segmentId: segment.id,
          meetingId,
          embedding: vectors[offset]!,
          model: env.embeddingModel,
        }))
      );
    }

    log.info("Meeting indexed", {
      meetingId,
      segments: indexed,
      durationMs: Date.now() - startedAt,
    });

    return indexed;
  } catch (error) {
    // Partial progress is kept: the next run picks up whatever is
    // still missing.
    log.warn("Indexing incomplete", {
      meetingId,
      indexed,
      pending: pending.length,
      reason: error instanceof Error ? error.message : String(error),
    });

    throw toGeminiError(
      error,
      "Could not index this meeting for search right now."
    );
  }
};

/** How much of the archive is searchable, for the search UI. */
export const indexStatus = async (meetingId?: string) => {
  const [segments, embedded] = await Promise.all([
    meetingId
      ? segmentRepo.countByMeetingId(meetingId)
      : undefined,
    meetingId
      ? embeddingRepo.countForMeeting(meetingId)
      : embeddingRepo.countAll(),
  ]);

  return { segments, embedded };
};
