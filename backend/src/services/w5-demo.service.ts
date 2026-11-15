import * as demoRepo from "../demo/demo.repository";
import { env } from "../lib/env";
import { AppError, BadRequest, NotFound } from "../types/errors";
import { formatTimestamp } from "../types/segment";

/**
 * Demo mode (w5-demo): who the demo visitor signs in as, and the
 * keyword search the demo uses instead of semantic search (which would
 * call Gemini to embed the query).
 */

export const demoStatus = () => ({ enabled: env.demoMode, readOnly: true });

/** The demo account and the meeting "Try the demo" opens first. */
export const demoAccount = async () => {
  if (!env.demoMode) throw NotFound("Demo mode is off on this server.");

  const user = await demoRepo.findDemoUser();
  if (!user) {
    throw new AppError("The demo has not been set up yet (npm --prefix backend run demo:seed).", 503);
  }

  return { user, meetingId: await demoRepo.firstMeetingId(user.id) };
};

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "what", "when", "who", "how", "did", "does", "with", "that",
  "this", "about", "from", "into", "have", "has", "will", "would", "you", "your", "our", "their", "they",
]);

/** Words worth matching: 3+ letters, not stop words, at most 8. */
export const searchTerms = (query: string): string[] => {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  const unique = [...new Set(words)].slice(0, 8);
  return unique.length ? unique : [query.trim().toLowerCase()].filter(Boolean);
};

/**
 * Same result shape as GET /search (search.service), scored by the
 * share of query terms a segment contains. Scoped to the caller's own
 * meetings like every search.
 */
export const keywordSearch = async (input: { userId: string; query: string; meetingId?: string | null; limit?: number }) => {
  const terms = searchTerms(input.query);
  if (!terms.length) throw BadRequest("Enter something to search for.");

  const limit = Math.min(Math.max(1, input.limit ?? 20), 50);
  const hits = await demoRepo.findSegmentsContaining(input.userId, terms, input.meetingId ?? null, 200);

  return hits
    .map((hit) => {
      const text = hit.text.toLowerCase();
      const matched = terms.filter((term) => text.includes(term)).length;
      return { ...hit, score: matched / terms.length, timestamp: formatTimestamp(hit.startMs) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};
