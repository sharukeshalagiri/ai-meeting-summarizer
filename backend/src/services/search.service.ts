import { env } from "../lib/env";
import {
  getClient,
  parseJsonResponse,
  toGeminiError,
  withRetry,
} from "../lib/gemini";
import { logger } from "../lib/logger";
import * as chatRepo from "../repositories/chat.repository";
import * as embeddingRepo from "../repositories/embedding.repository";
import { embedQuery } from "./embedding.service";
import { BadRequest } from "../types/errors";
import {
  CHAT_ANSWER_SCHEMA,
  type ChatAnswer,
  type Citation,
} from "../types/chat";
import { formatTimestamp } from "../types/segment";

const log = logger.child({ module: "search.service" });

/**
 * Retrieval-augmented search and chat over meeting transcripts.
 *
 * Retrieval returns segments, not whole meetings, so every answer can
 * cite the exact moment it came from.
 */

/** Segments retrieved per question. */
const DEFAULT_TOP_K = 12;

/**
 * Semantic search across one meeting or the whole archive.
 */
export const search = async (input: {
  query: string;
  meetingId?: string | null;
  limit?: number;
}) => {
  const query = input.query.trim();

  if (!query) {
    throw BadRequest("Enter something to search for.");
  }

  const embedding = await embedQuery(query);

  const hits = await embeddingRepo.search({
    embedding,
    limit: Math.min(input.limit ?? 20, 50),
    meetingId: input.meetingId ?? null,
  });

  log.debug("Search complete", {
    query: query.slice(0, 80),
    hits: hits.length,
  });

  return hits.map((hit) => ({
    ...hit,
    timestamp: formatTimestamp(hit.startMs),
  }));
};

const SYSTEM_INSTRUCTION = `
You answer questions about meetings using only the transcript excerpts
provided.

Each excerpt is numbered and labelled with its meeting, speaker, and
timestamp.

Rules:
- Answer only from the excerpts. If they do not contain the answer,
  say so plainly and leave citations empty. Never guess or fill gaps
  from general knowledge.
- Cite the excerpt numbers your answer rests on. Cite only excerpts
  you actually used.
- When the question is about a specific person, prefer excerpts where
  that person is the speaker.
- Quote deadlines, names, and figures exactly as they appear.
- Be direct and concise. Two or three sentences is usually enough.
`.trim();

/** Formats retrieved segments as the numbered context block. */
const toContext = (
  hits: Awaited<ReturnType<typeof embeddingRepo.search>>
): string =>
  hits
    .map(
      (hit, index) =>
        `[${index + 1}] Meeting: "${hit.meetingTitle}" | ` +
        `Speaker: ${hit.speaker} | ` +
        `Time: ${formatTimestamp(hit.startMs)}\n${hit.text}`
    )
    .join("\n\n");

/**
 * Maps the model's excerpt numbers back to real segments.
 *
 * A number outside the retrieved range means the model invented a
 * citation, so it is dropped rather than shown as a broken link.
 */
const resolveCitations = (
  indices: unknown,
  hits: Awaited<ReturnType<typeof embeddingRepo.search>>
): Citation[] => {
  if (!Array.isArray(indices)) return [];

  const seen = new Set<string>();

  return indices.flatMap((raw) => {
    const position = Number(raw);

    if (!Number.isInteger(position)) return [];

    const hit = hits[position - 1];

    if (!hit || seen.has(hit.segmentId)) return [];

    seen.add(hit.segmentId);

    return [
      {
        segmentId: hit.segmentId,
        meetingId: hit.meetingId,
        meetingTitle: hit.meetingTitle,
        speaker: hit.speaker,
        text: hit.text,
        startMs: hit.startMs,
        timestamp: formatTimestamp(hit.startMs),
      },
    ];
  });
};

/**
 * Answers a question from retrieved transcript segments.
 *
 * The conversation is persisted so a thread can be reopened, and so
 * the assistant's citations survive a page reload.
 */
export const ask = async (input: {
  question: string;
  conversationId: string;
  meetingId?: string | null;
}): Promise<ChatAnswer> => {
  const question = input.question.trim();

  if (!question) {
    throw BadRequest("Ask a question to get started.");
  }

  await chatRepo.create({
    conversationId: input.conversationId,
    meetingId: input.meetingId ?? null,
    role: "user",
    content: question,
    citations: null,
  });

  const embedding = await embedQuery(question);

  const hits = await embeddingRepo.search({
    embedding,
    limit: DEFAULT_TOP_K,
    meetingId: input.meetingId ?? null,
  });

  if (hits.length === 0) {
    const answer =
      "I could not find anything in the transcripts that answers " +
      "that. If the meeting was added recently it may still be " +
      "indexing.";

    await chatRepo.create({
      conversationId: input.conversationId,
      meetingId: input.meetingId ?? null,
      role: "assistant",
      content: answer,
      citations: null,
    });

    return { answer, citations: [] };
  }

  try {
    const response = await withRetry(() =>
      getClient().models.generateContent({
        model: env.geminiModel,

        contents:
          `Transcript excerpts:\n\n${toContext(hits)}\n\n` +
          `Question: ${question}`,

        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: CHAT_ANSWER_SCHEMA,
        },
      })
    );

    const parsed = parseJsonResponse(response.text ?? "", "answer");

    const answer =
      typeof parsed.answer === "string" && parsed.answer.trim()
        ? parsed.answer.trim()
        : "I could not find an answer to that in the transcripts.";

    const citations = resolveCitations(parsed.citations, hits);

    await chatRepo.create({
      conversationId: input.conversationId,
      meetingId: input.meetingId ?? null,
      role: "assistant",
      content: answer,
      citations: citations.length
        ? (citations as unknown as object[])
        : null,
    });

    log.info("Chat answered", {
      conversationId: input.conversationId,
      retrieved: hits.length,
      cited: citations.length,
    });

    return { answer, citations };
  } catch (error) {
    throw toGeminiError(
      error,
      "Could not answer that right now. Please try again."
    );
  }
};

export const getConversation = (conversationId: string) =>
  chatRepo.findByConversation(conversationId);
