import { env } from "../lib/env";
import {
  getClient,
  parseJsonResponse,
  toGeminiError,
  withRetry,
} from "../lib/gemini";
import { logger } from "../lib/logger";
import { resolveSpokenDate, isValidTimezone } from "../lib/dates";
import {
  MODE_PROMPTS,
  PROMPTS,
  promptVersions,
  withMode,
  type PromptDefinition,
} from "../prompts";
import {
  CLASSIFY_SCHEMA_V1,
  CLEAN_SCHEMA_V1,
  summaryBodySchemaV1,
} from "../prompts/schemas.v1";
import { BadRequest, UpstreamError } from "../types/errors";
import { formatTimestamp } from "../types/segment";
import {
  REVIEW_CONFIDENCE_THRESHOLD,
  ROLLING_SUMMARY_SCHEMA,
  SUMMARY_CAPS,
  SUMMARY_SCHEMA,
  SUMMARY_SCHEMA_VERSION,
  asPriority,
  asSentiment,
  isNoiseLabel,
  isSummaryMode,
  isSummaryV2,
  toLegacyView,
  type ActionItem,
  type DetectedMode,
  type Evidence,
  type ModeSetting,
  type NoiseLabel,
  type SummaryBody,
  type SummaryMode,
  type SummaryV2,
  type DiscussionTopic,
  type ImportantDate,
  type MeetingSentiment,
  type RollingSummaryData,
  type StructuredSummary,
} from "../types/summary";
import {
  parseClassification,
  parseNoiseLabels,
  parseSummaryBody,
} from "./w1-sum.parsers";

const log = logger.child({ module: "summary.service" });

const SYSTEM_INSTRUCTION = `
You are an AI Meeting Assistant. Extract structured intelligence from
meeting transcripts accurately and concisely.

Rules:
- Only use information present in the transcript. Never invent
  decisions, owners, dates, risks, or questions.
- Transcripts may be labelled with speakers and timestamps in the form
  "[12:34] Priya: ...". Use those labels to attribute action items and
  decisions to the right person. Never put a timestamp in your output.
- If an action item has no clear owner or due date, use null.
- Quote dates as the speaker stated them; do not convert relative
  dates into calendar dates.
- Distinguish a blocker (stopping work now) from a risk (might cause
  problems later).
- Return an empty array for any section the transcript does not cover.
  An empty section is correct and expected; padding it is not.
`.trim();

/** Narrowing helpers: the API is schema-constrained, but the response
 *  is still parsed JSON, so validate before trusting it. */
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asActionItems = (value: unknown): ActionItem[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    if (typeof item.task !== "string" || !item.task.trim()) return [];

    return [
      {
        task: item.task.trim(),
        owner: asNullableString(item.owner),
        dueDate: asNullableString(item.dueDate),
        priority: asPriority(item.priority),
      },
    ];
  });
};

const asImportantDates = (value: unknown): ImportantDate[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    if (typeof item.date !== "string" || !item.date.trim()) return [];

    return [
      {
        date: item.date.trim(),
        description:
          typeof item.description === "string"
            ? item.description.trim()
            : "",
      },
    ];
  });
};

const asDiscussionTopics = (value: unknown): DiscussionTopic[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    if (typeof item.topic !== "string" || !item.topic.trim()) return [];

    return [
      {
        topic: item.topic.trim(),
        summary:
          typeof item.summary === "string" ? item.summary.trim() : "",
      },
    ];
  });
};

const asMeetingSentiment = (value: unknown): MeetingSentiment => {
  if (typeof value !== "object" || value === null) {
    return { overall: "NEUTRAL", rationale: "" };
  }

  const item = value as Record<string, unknown>;

  return {
    overall: asSentiment(item.overall),
    rationale:
      typeof item.rationale === "string" ? item.rationale.trim() : "",
  };
};

/**
 * Validates a raw model response, and doubles as the reader for rows
 * stored before the schema was expanded: every field beyond the
 * original five degrades to empty rather than throwing.
 *
 * Exported so the parsing rules can be exercised without calling the
 * API.
 */
export const parseStructuredSummary = (
  raw: string | Record<string, unknown>
): StructuredSummary => {
  const value =
    typeof raw === "string" ? parseJsonResponse(raw, "summary") : raw;

  // Version 2 rows are projected onto this shape so analytics and other
  // v1 readers keep working (see toLegacyView).
  if (isSummaryV2(value)) {
    const mode = isSummaryMode(value.mode) ? value.mode : "GENERAL";
    const legacy = toLegacyView(parseSummaryBody(value, mode));

    if (!legacy.executiveSummary) {
      throw UpstreamError("The stored summary is empty.");
    }

    return legacy;
  }

  const executiveSummary =
    typeof value.executiveSummary === "string"
      ? value.executiveSummary.trim()
      : "";

  if (!executiveSummary) {
    throw UpstreamError(
      "The summary service returned an empty summary. Please try " +
        "again."
    );
  }

  return {
    executiveSummary,
    keyDecisions: asStringArray(value.keyDecisions),
    actionItems: asActionItems(value.actionItems),
    importantDates: asImportantDates(value.importantDates),
    followUps: asStringArray(value.followUps),

    risks: asStringArray(value.risks),
    blockers: asStringArray(value.blockers),
    openQuestions: asStringArray(value.openQuestions),
    discussionTopics: asDiscussionTopics(value.discussionTopics),
    keywords: asStringArray(value.keywords),
    sentiment: asMeetingSentiment(value.sentiment),
  };
};

/**
 * Renders the structured summary as markdown. Derived rather than
 * generated separately, so the two representations always agree.
 */
export const toMarkdown = (summary: StructuredSummary): string => {
  const section = (heading: string, lines: string[]): string =>
    `# ${heading}\n\n${
      lines.length ? lines.join("\n") : "_None recorded._"
    }`;

  const bullets = (lines: string[]) => lines.map((line) => `- ${line}`);

  const actionLines = summary.actionItems.map((item) => {
    const details = [
      item.owner ? `owner: ${item.owner}` : null,
      item.dueDate ? `due: ${item.dueDate}` : null,
      item.priority !== "MEDIUM"
        ? `priority: ${item.priority.toLowerCase()}`
        : null,
    ].filter(Boolean);

    return `- ${item.task}${
      details.length ? ` (${details.join(", ")})` : ""
    }`;
  });

  const dateLines = summary.importantDates.map((entry) =>
    entry.description
      ? `- **${entry.date}** — ${entry.description}`
      : `- **${entry.date}**`
  );

  const topicLines = summary.discussionTopics.map((entry) =>
    entry.summary
      ? `- **${entry.topic}** — ${entry.summary}`
      : `- **${entry.topic}**`
  );

  return [
    `# Executive Summary\n\n${summary.executiveSummary}`,
    section("Key Decisions", bullets(summary.keyDecisions)),
    section("Action Items", actionLines),
    section("Important Dates", dateLines),
    section("Risks", bullets(summary.risks)),
    section("Blockers", bullets(summary.blockers)),
    section("Open Questions", bullets(summary.openQuestions)),
    section("Discussion Topics", topicLines),
    section("Follow Ups", bullets(summary.followUps)),
    section("Keywords", bullets(summary.keywords)),
    `# Sentiment\n\n${summary.sentiment.overall}${
      summary.sentiment.rationale
        ? ` — ${summary.sentiment.rationale}`
        : ""
    }`,
  ].join("\n\n");
};

/**
 * Asks Gemini for schema-constrained meeting intelligence and returns
 * both the structured object and a markdown rendering of it.
 */
export async function generateSummary(
  transcript: string
): Promise<{ structured: StructuredSummary; markdown: string }> {
  if (!transcript.trim()) {
    throw BadRequest("There is no transcript text to summarize.");
  }

  try {
    const response = await withRetry(() =>
      getClient().models.generateContent({
        model: env.geminiModel,

        contents: `Transcript:\n${transcript}`,

        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: SUMMARY_SCHEMA,
        },
      })
    );

    const structured = parseStructuredSummary(response.text ?? "");

    return { structured, markdown: toMarkdown(structured) };
  } catch (error) {
    throw toGeminiError(
      error,
      "Could not generate a summary right now. Please try again."
    );
  }
}

const ROLLING_INSTRUCTION = `
You are an AI Meeting Assistant summarizing a meeting that is still in
progress.

Rules:
- Summarize only what has been said so far. The meeting is not over.
- Do not speculate about what will be decided later.
- Only use information present in the transcript.
- Return empty arrays for anything not yet covered.
`.trim();

/**
 * Point-in-time summary for a live meeting.
 *
 * Failures are the caller's to swallow: a missed rolling update should
 * never interrupt an ongoing capture.
 */
export async function generateRollingSummary(
  transcript: string
): Promise<RollingSummaryData> {
  if (!transcript.trim()) {
    throw BadRequest("There is no transcript text to summarize yet.");
  }

  try {
    const response = await withRetry(
      () =>
        getClient().models.generateContent({
          model: env.geminiModel,

          contents: `Meeting so far:\n${transcript}`,

          config: {
            systemInstruction: ROLLING_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema: ROLLING_SUMMARY_SCHEMA,
          },
        }),
      // One retry only: another chunk arrives within minutes, so a
      // slow recovery is worse than skipping this update.
      2
    );

    const value = parseJsonResponse(
      response.text ?? "",
      "rolling summary"
    );

    const headline =
      typeof value.headline === "string" ? value.headline.trim() : "";

    log.debug("Rolling summary generated", {
      characters: transcript.length,
    });

    return {
      headline: headline || "Meeting in progress.",
      recentPoints: asStringArray(value.recentPoints),
      decisions: asStringArray(value.decisions),
      actionItems: asActionItems(value.actionItems),
      openQuestions: asStringArray(value.openQuestions),
    };
  } catch (error) {
    throw toGeminiError(
      error,
      "Could not generate a live update right now."
    );
  }
}

/* =========================================================
   Summary pipeline v2: CLASSIFY -> CLEAN -> EXTRACT (map-reduce)
   -> VERIFY -> finalize in code
   ========================================================= */

/** A transcript segment as the pipeline needs it. */
export interface PipelineSegment {
  /** TranscriptSegment.idx; sparse for live capture. */
  idx: number;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  /** Existing CLEAN label; segments that have one are not re-labelled. */
  noiseLabel?: string | null;
}

export interface NoiseLabelUpdate {
  idx: number;
  label: NoiseLabel;
}

export interface PipelineOptions {
  /** Meeting.mode or the user's override. AUTO runs CLASSIFY. */
  modeSetting: ModeSetting;
  /** Anchor for relative deadlines ("tomorrow"). */
  meetingStart: Date;
  /** IANA zone for date resolution; UTC when missing or unknown. */
  timezone?: string | null;
  /** Names, jargon or agenda from the recorder (LiveSession.hints). */
  hints?: string[];
  /**
   * Persists CLEAN labels (TranscriptSegment.noiseLabel). Injected so
   * this service stays free of segment storage; a failure is logged and
   * does not fail the summary.
   */
  writeNoiseLabels?: (labels: NoiseLabelUpdate[]) => Promise<void>;
  /** Estimated tokens of transcript per EXTRACT call (map step). */
  tokenBudget?: number;
  /** Segments per CLEAN call. */
  cleanBatchSize?: number;
}

export interface PipelineResult {
  summary: SummaryV2;
  markdown: string;
  /** Final label per idx, including labels that were already stored. */
  labels: Map<number, NoiseLabel>;
}

const DEFAULT_TOKEN_BUDGET = 12_000;
const DEFAULT_CLEAN_BATCH = 150;
/** CLASSIFY reads this much of the start of the meeting. */
const CLASSIFY_WINDOW_MS = 5 * 60 * 1000;
const CLASSIFY_MAX_CHARS = 8_000;

/** Rough token estimate (about four characters per token for English). */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4);

/** "[#12 1:16] Marcus: text": the id the model must cite is after '#'. */
export const formatSegmentLine = (segment: PipelineSegment): string =>
  `[#${segment.idx} ${formatTimestamp(segment.startMs)}] ${segment.speaker}: ${segment.text}`;

/**
 * Splits segments into consecutive chunks whose formatted lines fit the
 * token budget. A single oversized segment still gets its own chunk.
 */
export const chunkByTokenBudget = (
  segments: PipelineSegment[],
  budget: number
): PipelineSegment[][] => {
  const chunks: PipelineSegment[][] = [];
  let current: PipelineSegment[] = [];
  let used = 0;

  for (const segment of segments) {
    const cost = estimateTokens(formatSegmentLine(segment)) + 1;

    if (current.length && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }

    current.push(segment);
    used += cost;
  }

  if (current.length) chunks.push(current);

  return chunks;
};

const modelFor = (prompt: { model: "main" | "clean" }) =>
  prompt.model === "clean" ? env.geminiCleanModel : env.geminiModel;

/**
 * One schema-constrained Gemini call at temperature 0, through the
 * shared client, retry policy and error mapping in lib/gemini.ts.
 * Returns parsed-but-unvalidated JSON: every caller narrows it.
 */
const callModel = async (input: {
  prompt: PromptDefinition;
  system?: string;
  contents: string;
  schema: Record<string, unknown>;
  failure: string;
}): Promise<Record<string, unknown>> => {
  try {
    const response = await withRetry(() =>
      getClient().models.generateContent({
        model: modelFor(input.prompt),
        contents: input.contents,
        config: {
          systemInstruction: input.system ?? input.prompt.system,
          responseMimeType: "application/json",
          responseSchema: input.schema,
          temperature: 0,
        },
      })
    );

    return parseJsonResponse(response.text ?? "", `${input.prompt.id} result`);
  } catch (error) {
    throw toGeminiError(error, input.failure);
  }
};

const hintsBlock = (hints?: string[]) =>
  hints && hints.length
    ? `Context from the recorder (names, jargon, agenda):\n${hints
        .map((hint) => `- ${hint}`)
        .join("\n")}\n\n`
    : "";

/** CLASSIFY: guesses the mode from the opening minutes. */
export const classifyMode = async (
  segments: PipelineSegment[],
  hints?: string[]
): Promise<DetectedMode> => {
  const first = segments[0]?.startMs ?? 0;
  let text = "";

  for (const segment of segments) {
    if (segment.startMs - first > CLASSIFY_WINDOW_MS) break;

    const line = formatSegmentLine(segment);
    if (text.length + line.length > CLASSIFY_MAX_CHARS) break;

    text += `${line}\n`;
  }

  const raw = await callModel({
    prompt: PROMPTS.classify,
    contents: `${hintsBlock(hints)}Opening of the session:\n${text}`,
    schema: CLASSIFY_SCHEMA_V1,
    failure: "Could not detect the meeting type right now.",
  });

  return parseClassification(raw);
};

/**
 * CLEAN: labels each segment that has no label yet. Never removes or
 * edits text. If the cheap model fails, unlabelled segments count as
 * substantive for this run (nothing is persisted), so a CLEAN outage
 * makes the summary noisier rather than missing.
 */
export const cleanSegments = async (
  segments: PipelineSegment[],
  options: Pick<PipelineOptions, "writeNoiseLabels" | "cleanBatchSize">
): Promise<Map<number, NoiseLabel>> => {
  const labels = new Map<number, NoiseLabel>();
  const pending: PipelineSegment[] = [];

  for (const segment of segments) {
    if (isNoiseLabel(segment.noiseLabel)) labels.set(segment.idx, segment.noiseLabel);
    else pending.push(segment);
  }

  const batchSize = Math.max(1, options.cleanBatchSize ?? DEFAULT_CLEAN_BATCH);
  const fresh: NoiseLabelUpdate[] = [];

  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    const asked = batch.map((segment) => segment.idx);

    try {
      const raw = await callModel({
        prompt: PROMPTS.clean,
        contents: `Label every segment:\n${batch.map(formatSegmentLine).join("\n")}`,
        schema: CLEAN_SCHEMA_V1,
        failure: "Could not label the transcript right now.",
      });

      for (const [idx, label] of parseNoiseLabels(raw, asked)) {
        labels.set(idx, label);
        fresh.push({ idx, label });
      }
    } catch (error) {
      log.warn("CLEAN batch failed; treating it as substantive", {
        segments: asked.length,
        reason: error instanceof Error ? error.message : String(error),
      });

      for (const idx of asked) labels.set(idx, "substantive");
    }
  }

  if (fresh.length && options.writeNoiseLabels) {
    try {
      await options.writeNoiseLabels(fresh);
    } catch (error) {
      log.warn("Could not store noise labels", {
        labels: fresh.length,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return labels;
};

const bodySchemaFor = (mode: SummaryMode) => {
  const modePrompt = MODE_PROMPTS[mode];

  return summaryBodySchemaV1(
    modePrompt ? { key: modePrompt.sectionKey, schema: modePrompt.schema } : undefined
  );
};

/** EXTRACT for one chunk of substantive segments (the map step). */
const extractChunk = async (
  chunk: PipelineSegment[],
  mode: SummaryMode,
  hints: string[] | undefined,
  part: { index: number; total: number }
): Promise<SummaryBody<number>> => {
  const header =
    part.total > 1
      ? `This is part ${part.index + 1} of ${part.total} of the meeting.\n\n`
      : "";

  const raw = await callModel({
    prompt: PROMPTS.extract,
    system: withMode(PROMPTS.extract, mode),
    contents: `${hintsBlock(hints)}${header}Transcript:\n${chunk
      .map(formatSegmentLine)
      .join("\n")}`,
    schema: bodySchemaFor(mode),
    failure: "Could not generate a summary right now. Please try again.",
  });

  return parseSummaryBody(raw, mode);
};

/** REDUCE: merges per-chunk results of a long meeting. */
const reduceParts = async (
  parts: SummaryBody<number>[],
  mode: SummaryMode
): Promise<SummaryBody<number>> => {
  const raw = await callModel({
    prompt: PROMPTS.reduce,
    system: withMode(PROMPTS.reduce, mode),
    contents: parts
      .map((part, index) => `Part ${index + 1}:\n${JSON.stringify(part)}`)
      .join("\n\n"),
    schema: bodySchemaFor(mode),
    failure: "Could not combine the summary of a long meeting.",
  });

  return parseSummaryBody(raw, mode);
};

/** Every evidence id anywhere in a body, for VERIFY's context. */
const collectEvidenceIds = (node: unknown, into = new Set<number>()): Set<number> => {
  if (Array.isArray(node)) {
    for (const entry of node) collectEvidenceIds(entry, into);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "evidence" && Array.isArray(value)) {
        for (const id of value) if (typeof id === "number") into.add(id);
      } else {
        collectEvidenceIds(value, into);
      }
    }
  }

  return into;
};

/** VERIFY: checks the draft against the segments it cites. */
const verifyDraft = async (
  draft: SummaryBody<number>,
  mode: SummaryMode,
  byIdx: Map<number, PipelineSegment>
): Promise<SummaryBody<number>> => {
  const cited = [...collectEvidenceIds(draft)]
    .sort((a, b) => a - b)
    .flatMap((idx) => {
      const segment = byIdx.get(idx);
      return segment ? [formatSegmentLine(segment)] : [];
    });

  const raw = await callModel({
    prompt: PROMPTS.verify,
    system: withMode(PROMPTS.verify, mode),
    contents:
      `Draft summary:\n${JSON.stringify(draft)}\n\n` +
      `Cited transcript lines:\n${cited.join("\n")}`,
    schema: bodySchemaFor(mode),
    failure: "Could not verify the summary right now.",
  });

  return parseSummaryBody(raw, mode);
};

const DROP = Symbol("drop");

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** At most `count` sentences. */
export const capSentences = (text: string, count: number): string => {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  return sentences.slice(0, count).join("").trim();
};

interface FinalizeContext {
  /** Segments an item may cite: the substantive ones. */
  allowed: Map<number, PipelineSegment>;
  meetingStart: Date;
  timezone: string;
  dropped: number;
}

/**
 * Walks the draft and, for every object carrying `evidence`:
 * keeps only ids of real substantive segments (so nothing cites small
 * talk or a hallucinated id) and drops the item if none remain; copies
 * speaker and startMs from the segment; sets needsReview from
 * confidence; resolves `dueSpoken` / `spoken` with lib/dates; clips
 * long text. Generic so a new mode section is covered without changes.
 */
const finalizeNode = (node: unknown, ctx: FinalizeContext): unknown => {
  if (Array.isArray(node)) {
    return node
      .map((entry) => finalizeNode(entry, ctx))
      .filter((entry) => entry !== DROP);
  }

  if (typeof node === "string") return clip(node, SUMMARY_CAPS.itemChars);

  if (typeof node !== "object" || node === null) return node;

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key !== "evidence") out[key] = finalizeNode(value, ctx);
  }

  if (Array.isArray(source.evidence)) {
    const evidence: Evidence[] = source.evidence.flatMap((id) => {
      const segment = typeof id === "number" ? ctx.allowed.get(id) : undefined;
      return segment
        ? [{ idx: segment.idx, speaker: segment.speaker, startMs: segment.startMs }]
        : [];
    });

    if (!evidence.length) {
      ctx.dropped++;
      return DROP;
    }

    evidence.sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);

    const confidence = typeof source.confidence === "number" ? source.confidence : 0.5;

    out.evidence = evidence;
    out.confidence = confidence;
    out.needsReview = confidence < REVIEW_CONFIDENCE_THRESHOLD;
  }

  const resolve = (spoken: unknown) =>
    typeof spoken === "string"
      ? resolveSpokenDate(spoken, {
          meetingStart: ctx.meetingStart,
          timezone: ctx.timezone,
        })
      : null;

  if ("dueSpoken" in source) out.dueDate = resolve(source.dueSpoken);
  if ("spoken" in source && "date" in source) out.date = resolve(source.spoken);

  return out;
};

/** Caps list lengths that VERIFY was asked to respect. */
const capBody = (body: SummaryBody<Evidence>): SummaryBody<Evidence> => {
  const cap = <T>(items: T[]) => items.slice(0, SUMMARY_CAPS.listItems);
  const project = body.sections.project;

  return {
    ...body,
    tldr: capSentences(body.tldr, SUMMARY_CAPS.tldrSentences),
    keyPoints: body.keyPoints.slice(0, SUMMARY_CAPS.keyPoints),
    decisions: cap(body.decisions),
    actionItems: cap(body.actionItems),
    dates: cap(body.dates),
    openQuestions: cap(body.openQuestions),
    glossary: cap(body.glossary),
    nextSessionPrep: cap(body.nextSessionPrep),
    keywords: body.keywords.slice(0, 12),
    sections: project
      ? {
          ...body.sections,
          // A person with nothing left after verification is noise.
          project: {
            ...project,
            people: project.people.filter(
              (person) => person.done.length + person.next.length + person.blockers.length > 0
            ),
          },
        }
      : body.sections,
  };
};

/** Applies finalizeNode to a body. Exported for tests. */
export const finalizeBody = (
  draft: SummaryBody<number>,
  ctx: Omit<FinalizeContext, "dropped">
): { body: SummaryBody<Evidence>; dropped: number } => {
  const context: FinalizeContext = { ...ctx, dropped: 0 };

  // finalizeNode maps every `evidence: number[]` to Evidence[] and
  // leaves all other fields in place, so the result has the
  // SummaryBody<Evidence> shape; TypeScript cannot follow a generic
  // walk, hence the single cast.
  const body = finalizeNode(draft, context) as SummaryBody<Evidence>;

  // The tldr is capped by sentences, not clipped mid-word like items.
  return { body: capBody({ ...body, tldr: draft.tldr }), dropped: context.dropped };
};

const NO_SUBSTANCE = "No substantive discussion was found in this recording.";

const emptyBody = (): SummaryBody<number> => ({
  tldr: NO_SUBSTANCE,
  keyPoints: [],
  decisions: [],
  actionItems: [],
  dates: [],
  openQuestions: [],
  whoSaidWhat: [],
  glossary: [],
  nextSessionPrep: [],
  keywords: [],
  sentiment: { overall: "NEUTRAL", rationale: "" },
  sections: {},
});

/**
 * Runs the full v2 pipeline over a meeting's segments.
 *
 * Calls happen one after another rather than in parallel: free-tier
 * rate limits are per minute, and a long meeting is a handful of calls.
 */
export async function runSummaryPipeline(
  input: PipelineSegment[],
  options: PipelineOptions
): Promise<PipelineResult> {
  // Order by idx and drop duplicates: idx is the identity, never the
  // array position.
  const byIdx = new Map<number, PipelineSegment>();
  for (const segment of input) {
    if (Number.isInteger(segment.idx) && segment.text.trim()) byIdx.set(segment.idx, segment);
  }
  const segments = [...byIdx.values()].sort((a, b) => a.idx - b.idx);

  if (!segments.length) {
    throw BadRequest("There are no transcript segments to summarize.");
  }

  const timezone = isValidTimezone(options.timezone) ? (options.timezone as string) : "UTC";
  const used: (keyof typeof PROMPTS)[] = [];

  // 1. Mode.
  let mode: SummaryMode;
  let detectedMode: DetectedMode | null = null;

  if (options.modeSetting === "AUTO") {
    detectedMode = await classifyMode(segments, options.hints);
    mode = detectedMode.mode;
    used.push("classify");
  } else {
    mode = options.modeSetting;
  }

  // 2. CLEAN.
  const labels = await cleanSegments(segments, options);
  if (segments.some((segment) => !isNoiseLabel(segment.noiseLabel))) used.push("clean");

  const substantive = segments.filter((segment) => labels.get(segment.idx) === "substantive");
  const allowed = new Map(substantive.map((segment) => [segment.idx, segment]));

  // 3. EXTRACT (map), REDUCE, VERIFY.
  const chunks = chunkByTokenBudget(substantive, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  let draft = emptyBody();

  if (chunks.length) {
    used.push("extract");

    const parts: SummaryBody<number>[] = [];
    for (const [index, chunk] of chunks.entries()) {
      parts.push(await extractChunk(chunk, mode, options.hints, { index, total: chunks.length }));
    }

    if (parts.length > 1) {
      used.push("reduce");
      draft = await reduceParts(parts, mode);
    } else {
      draft = parts[0];
    }

    used.push("verify");
    try {
      draft = await verifyDraft(draft, mode, byIdx);
    } catch (error) {
      // An unverified summary is still useful, but every item is shown
      // as "needs review" so nobody mistakes it for a checked one.
      log.warn("VERIFY failed; keeping the draft for review", {
        reason: error instanceof Error ? error.message : String(error),
      });
      draft = JSON.parse(
        JSON.stringify(draft, (key, value) =>
          key === "confidence" && typeof value === "number" ? Math.min(value, 0.5) : value
        )
      ) as SummaryBody<number>;
    }
  }

  // 4. Finalize in code: evidence, dates, review flags, caps.
  const { body, dropped } = finalizeBody(draft, {
    allowed,
    meetingStart: options.meetingStart,
    timezone,
  });

  const summary: SummaryV2 = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    mode,
    modeSetting: options.modeSetting,
    detectedMode,
    ...body,
    tldr: body.tldr || (substantive.length ? "Summary unavailable." : NO_SUBSTANCE),
    prompts: promptVersions(mode, used),
    stats: {
      segments: segments.length,
      substantiveSegments: substantive.length,
      chunks: chunks.length,
      droppedItems: dropped,
      timezone,
      meetingStart: options.meetingStart.toISOString(),
    },
  };

  log.info("Summary pipeline complete", {
    mode,
    detected: detectedMode?.mode ?? null,
    segments: segments.length,
    substantive: substantive.length,
    chunks: chunks.length,
    droppedItems: dropped,
    actionItems: summary.actionItems.length,
  });

  return { summary, markdown: toMarkdownV2(summary), labels };
}

/* ---------- markdown for v2 ---------- */

const MODE_TITLES: Record<SummaryMode, string> = {
  GENERAL: "General",
  LECTURE: "Lecture",
  INTERVIEW: "Interview",
  PROJECT: "Project",
  ONE_ON_ONE: "1:1",
};

const cite = (evidence: Evidence[]) =>
  evidence.length ? ` _[${evidence.map((entry) => formatTimestamp(entry.startMs)).join(", ")}]_` : "";

const review = (item: { needsReview: boolean }) => (item.needsReview ? " (needs review)" : "");

/**
 * Markdown rendering of a v2 summary for Summary.content. Derived from
 * the structured data so the two never disagree; empty sections are
 * left out instead of printed as "None".
 */
export const toMarkdownV2 = (summary: SummaryV2): string => {
  const blocks: string[] = [`# TL;DR (${MODE_TITLES[summary.mode]})\n\n${summary.tldr}`];

  const section = (heading: string, lines: string[]) => {
    if (lines.length) blocks.push(`# ${heading}\n\n${lines.join("\n")}`);
  };

  section(
    "Action Items",
    summary.actionItems.map((item) => {
      const details = [
        item.owner ? `owner: ${item.owner}` : null,
        item.dueSpoken ? `due: ${item.dueSpoken}${item.dueDate ? ` (${item.dueDate})` : ""}` : null,
        item.assignedBy ? `from: ${item.assignedBy}` : null,
      ].filter(Boolean);

      return `- ${item.task}${details.length ? ` (${details.join(", ")})` : ""}${review(item)}${cite(item.evidence)}`;
    })
  );

  section(
    "Dates",
    summary.dates.map(
      (entry) =>
        `- **${entry.spoken}**${entry.date ? ` (${entry.date})` : ""}${
          entry.description ? ` — ${entry.description}` : ""
        }${cite(entry.evidence)}`
    )
  );

  section(
    "Decisions",
    summary.decisions.map(
      (item) => `- ${item.text}${item.decidedBy ? ` (${item.decidedBy})` : ""}${review(item)}${cite(item.evidence)}`
    )
  );

  const lecture = summary.sections.lecture;
  if (lecture) {
    section(
      "Exam: flagged by the lecturer",
      lecture.examQuestions.flaggedByLecturer.map((item) => `- ${item.question}${cite(item.evidence)}`)
    );
    section(
      "Exam: likely",
      lecture.examQuestions.likely.map((item) => `- ${item.question} — ${item.reason}${cite(item.evidence)}`)
    );
    section(
      "Assignments",
      lecture.assignments.map((item) => `- ${item.task}${item.dueSpoken ? ` (due: ${item.dueSpoken})` : ""}${cite(item.evidence)}`)
    );
    section(
      "Definitions",
      lecture.definitions.map((item) => `- **${item.term}** — ${item.definition}${cite(item.evidence)}`)
    );
  }

  const interview = summary.sections.interview;
  if (interview) {
    section(
      "Questions and answers",
      interview.qa.map((item) => `- **${item.question}** — ${item.answerSummary}${cite(item.evidence)}`)
    );
    section("Next steps", interview.nextSteps.map((item) => `- ${item.text}${cite(item.evidence)}`));
  }

  const project = summary.sections.project;
  if (project) {
    section(
      "Status by person",
      project.people.map((person) =>
        [
          `- **${person.name}**`,
          ...person.done.map((item) => `  - done: ${item.text}`),
          ...person.next.map((item) => `  - next: ${item.text}`),
          ...person.blockers.map((item) => `  - blocked: ${item.text}`),
        ].join("\n")
      )
    );
    section("Risks", project.risks.map((item) => `- ${item.text}${cite(item.evidence)}`));
  }

  const oneOnOne = summary.sections.oneOnOne;
  if (oneOnOne) {
    section("Commitments", oneOnOne.commitments.map((item) => `- ${item.who}: ${item.text}${cite(item.evidence)}`));
    section("Feedback", oneOnOne.feedback.map((item) => `- ${item.speaker}: ${item.text}${cite(item.evidence)}`));
  }

  section("Open Questions", summary.openQuestions.map((item) => `- ${item.text}${cite(item.evidence)}`));
  section("Key Points", summary.keyPoints.map((item) => `- ${item.text}${cite(item.evidence)}`));
  section("Next Session Prep", summary.nextSessionPrep.map((item) => `- ${item.text}`));

  return blocks.join("\n\n");
};
