import { Type } from "@google/genai";
import { env } from "../../lib/env";
import {
  getClient,
  parseJsonResponse,
  toGeminiError,
  withRetry,
} from "../../lib/gemini";
import { logger } from "../../lib/logger";
import * as seriesRepo from "../../repositories/series.repository";

const log = logger.child({ module: "sinceLastTime" });

/**
 * "Since last time": for a meeting in a series, what happened to the
 * open action items of the earlier meetings. Each one is judged from
 * this meeting's transcript as done, still open, or not mentioned, with
 * the segments (TranscriptSegment.idx) that show it.
 *
 * Nothing is changed automatically. A "done" item carries a suggested
 * status (COMPLETED) that the user confirms or dismisses
 * (POST /meetings/:id/since-last-time/:actionItemId). The result is
 * stored in Summary.data.sinceLastTime, so it needs no schema.
 */

export const SINCE_STATUSES = ["done", "still_open", "not_mentioned"] as const;
export type SinceStatus = (typeof SINCE_STATUSES)[number];

export interface SinceLastTimeItem {
  actionItemId: string;
  task: string;
  owner: string | null;
  dueSpoken: string | null;
  fromMeeting: { id: string; title: string; createdAt: string };
  status: SinceStatus;
  /** Why, in a few words, quoted or paraphrased from the transcript. */
  note: string | null;
  /** Supporting segments, by TranscriptSegment.idx. */
  evidence: { idx: number; startMs: number; speaker: string }[];
  /** The change the user is asked to confirm; null = nothing to do. */
  suggestedStatus: "COMPLETED" | null;
  /** What the user did with the suggestion. */
  resolution: "applied" | "dismissed" | null;
}

export interface SinceLastTime {
  version: 1;
  seriesId: string;
  generatedAt: string;
  items: SinceLastTimeItem[];
}

export interface SinceSegment {
  idx: number;
  speaker: string;
  text: string;
  startMs: number;
  noiseLabel?: string | null;
}

export interface EarlierItem {
  id: string;
  task: string;
  owner: string | null;
  dueSpoken: string | null;
  meeting: { id: string; title: string; createdAt: Date };
}

/** Raw model verdict for item number `n` (1-based). */
export interface Verdict {
  n: number;
  status: SinceStatus;
  evidence: number[];
  note: string | null;
}

/** Earlier open items considered per meeting; newest first. */
export const MAX_EARLIER_ITEMS = 30;
/** Transcript characters sent; the start of a long meeting is enough. */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Labels the CLEAN pass gives to talk that is not about the work. */
const NOISE = new Set(["small_talk", "logistics", "filler", "off_topic"]);

const SYSTEM = `
You compare a list of OPEN TASKS from earlier meetings with the
TRANSCRIPT of the latest meeting in the same series.

For every task, decide from the transcript alone:
- "done": someone says it is finished, delivered, sent, merged, fixed.
- "still_open": it is discussed but not finished (in progress, delayed,
  blocked, re-assigned, or a new deadline).
- "not_mentioned": the transcript does not talk about it.

Rules:
- Use only the transcript. Never assume a task is done because time has
  passed or because a similar task was mentioned.
- If unsure between "done" and "still_open", answer "still_open".
- evidence: the [#idx] numbers of the segments that show the status;
  empty for "not_mentioned". Only use numbers present in the transcript.
- note: at most 15 words, quoting the transcript where possible. Quote
  dates as spoken; do not resolve them.
- Return one verdict per task, using the task's number n.
`.trim();

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          n: { type: Type.INTEGER },
          status: { type: Type.STRING, enum: [...SINCE_STATUSES] },
          evidence: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          note: { type: Type.STRING, nullable: true },
        },
        required: ["n", "status", "evidence"],
      },
    },
  },
  required: ["verdicts"],
};

export const buildPrompt = (items: EarlierItem[], segments: SinceSegment[]): string => {
  const tasks = items
    .map(
      (item, i) =>
        `${i + 1}. ${item.task}` +
        (item.owner ? ` (owner: ${item.owner})` : "") +
        (item.dueSpoken ? ` (due: ${item.dueSpoken})` : "")
    )
    .join("\n");

  let transcript = "";
  for (const segment of segments) {
    const line = `[#${segment.idx}] ${segment.speaker}: ${segment.text}\n`;
    if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) break;
    transcript += line;
  }

  return `OPEN TASKS:\n${tasks}\n\nTRANSCRIPT:\n${transcript}`;
};

/** Narrows the model's JSON; anything unusable becomes "not_mentioned". */
export const parseVerdicts = (value: unknown, count: number, validIdx: Set<number>): Verdict[] => {
  const raw =
    typeof value === "object" && value !== null && Array.isArray((value as { verdicts?: unknown }).verdicts)
      ? ((value as { verdicts: unknown[] }).verdicts)
      : [];

  const byN = new Map<number, Verdict>();

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const n = Number(record.n);
    if (!Number.isInteger(n) || n < 1 || n > count || byN.has(n)) continue;

    const status = SINCE_STATUSES.find((s) => s === record.status) ?? "not_mentioned";
    const evidence = Array.isArray(record.evidence)
      ? [...new Set(record.evidence.map(Number).filter((idx) => validIdx.has(idx)))].slice(0, 5)
      : [];
    const note =
      typeof record.note === "string" && record.note.trim() ? record.note.trim().slice(0, 200) : null;

    // "done" without any real evidence is not trusted.
    byN.set(n, {
      n,
      status: status === "done" && evidence.length === 0 ? "still_open" : status,
      evidence: status === "not_mentioned" ? [] : evidence,
      note,
    });
  }

  return Array.from({ length: count }, (_, i) =>
    byN.get(i + 1) ?? { n: i + 1, status: "not_mentioned", evidence: [], note: null }
  );
};

export type Judge = (prompt: string) => Promise<unknown>;

/** The Gemini call; tests pass their own `judge`. */
export const geminiJudge: Judge = async (prompt) => {
  try {
    const response = await withRetry(() =>
      getClient().models.generateContent({
        model: env.geminiModel,
        contents: prompt,
        config: {
          systemInstruction: SYSTEM,
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      })
    );
    return parseJsonResponse(response.text ?? "", "since-last-time");
  } catch (error) {
    throw toGeminiError(error, "Could not compare with the last meeting");
  }
};

export const combine = (
  items: EarlierItem[],
  verdicts: Verdict[],
  segments: SinceSegment[],
  seriesId: string,
  now = new Date()
): SinceLastTime => {
  const byIdx = new Map(segments.map((segment) => [segment.idx, segment]));

  return {
    version: 1,
    seriesId,
    generatedAt: now.toISOString(),
    items: items.map((item, i) => {
      const verdict = verdicts[i];
      return {
        actionItemId: item.id,
        task: item.task,
        owner: item.owner,
        dueSpoken: item.dueSpoken,
        fromMeeting: {
          id: item.meeting.id,
          title: item.meeting.title,
          createdAt: item.meeting.createdAt.toISOString(),
        },
        status: verdict.status,
        note: verdict.note,
        evidence: verdict.evidence.flatMap((idx) => {
          const segment = byIdx.get(idx);
          return segment ? [{ idx, startMs: segment.startMs, speaker: segment.speaker }] : [];
        }),
        suggestedStatus: verdict.status === "done" ? "COMPLETED" : null,
        resolution: null,
      };
    }),
  };
};

export interface SinceDeps {
  earlierItems: (input: Parameters<typeof seriesRepo.findEarlierOpenItems>[0]) => Promise<EarlierItem[]>;
  judge: Judge;
}

const defaultDeps: SinceDeps = {
  earlierItems: (input) => seriesRepo.findEarlierOpenItems(input),
  judge: geminiJudge,
};

/**
 * Null when the meeting is not in a series or nothing earlier is open
 * (no model call is made then).
 */
export const computeSinceLastTime = async (
  meeting: { id: string; userId: string; seriesId: string | null; createdAt: Date },
  segments: SinceSegment[],
  deps: SinceDeps = defaultDeps
): Promise<SinceLastTime | null> => {
  if (!meeting.seriesId) return null;

  const items = await deps.earlierItems({
    seriesId: meeting.seriesId,
    userId: meeting.userId,
    meetingId: meeting.id,
    before: meeting.createdAt,
    limit: MAX_EARLIER_ITEMS,
  });

  if (items.length === 0) return null;

  const usable = segments.filter((segment) => !NOISE.has(segment.noiseLabel ?? ""));
  const validIdx = new Set(usable.map((segment) => segment.idx));

  const raw = await deps.judge(buildPrompt(items, usable));
  const verdicts = parseVerdicts(raw, items.length, validIdx);

  log.info("Since last time compared", {
    meetingId: meeting.id,
    items: items.length,
    done: verdicts.filter((v) => v.status === "done").length,
  });

  return combine(items, verdicts, usable, meeting.seriesId);
};

/** Reads a stored value back, or null when it is not one of ours. */
export const readSinceLastTime = (value: unknown): SinceLastTime | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<SinceLastTime>;
  return record.version === 1 && Array.isArray(record.items) ? (record as SinceLastTime) : null;
};
