import { resolveSpokenDate } from "../lib/dates";
import type { Evidence, NoiseLabel, SummaryV2 } from "../types/summary";
import { interview } from "./content/interview";
import { lecture } from "./content/lecture";
import { project } from "./content/project";
import type {
  DemoActionItem,
  DemoMeeting,
  DemoMeetingSpec,
  DemoSegment,
  DemoSpeaker,
  SegmentTiming,
} from "./types";

/**
 * Turns the hand-written demo specs into exactly what the seed stores:
 * segments with idx, timings, channel, speaker label and noise label;
 * speaker profiles; a schemaVersion 2 summary with full Evidence; and
 * ActionItem rows. Pure (no env, database or network), so the seed,
 * the tests and the screenshot runner all build the same data.
 */

/** Newest first, as the dashboard lists them. */
export const DEMO_SPECS: readonly DemoMeetingSpec[] = [lecture, interview, project];

export const MIC_LABEL = "mic";

/** Silence between two lines, in the generated audio and the estimate. */
export const LINE_GAP_MS = 450;

/**
 * Timings when no real audio was generated (screenshots, tests): about
 * 2.6 words a second, at least 1.5 s a line. The seed replaces these
 * with the lengths of the generated speech.
 */
export const estimateTimings = (lines: readonly (readonly [string, string])[]): SegmentTiming[] => {
  let cursor = 0;
  return lines.map(([, text]) => {
    const words = text.split(/\s+/).filter(Boolean).length;
    const duration = Math.max(1500, Math.round(words * 385));
    const timing = { startMs: cursor, endMs: cursor + duration };
    cursor = timing.endMs + LINE_GAP_MS;
    return timing;
  });
};

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** Speaker profile labels: the user is "mic", others "Speaker 2", 3... */
export const speakersOf = (spec: DemoMeetingSpec): DemoSpeaker[] => {
  const others: string[] = [];
  for (const [speaker] of spec.lines) {
    if (speaker !== spec.me && !others.includes(speaker)) others.push(speaker);
  }
  return [
    { label: MIC_LABEL, displayName: spec.me, isMe: true },
    ...others.map((name, i) => ({ label: `Speaker ${i + 2}`, displayName: name, isMe: false })),
  ];
};

type Walkable = unknown;

/**
 * Deep copy of a summary body that turns every `evidence: number[]`
 * into Evidence rows from the real segments (throwing on an idx that
 * does not exist) and resolves spoken dates against the meeting start,
 * as the pipeline's VERIFY step and lib/dates do.
 */
const resolveBody = (value: Walkable, segments: Map<number, DemoSegment>, meetingStart: Date, where: string): Walkable => {
  if (Array.isArray(value)) return value.map((entry, i) => resolveBody(entry, segments, meetingStart, `${where}[${i}]`));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === "evidence" ? toEvidence(child, segments, where) : resolveBody(child, segments, meetingStart, `${where}.${key}`);
  }

  const ref = { meetingStart, timezone: "UTC" };
  if ("dueSpoken" in out && "dueDate" in out) out.dueDate = resolveSpokenDate(out.dueSpoken as string | null, ref);
  if ("spoken" in out && "date" in out) out.date = resolveSpokenDate(out.spoken as string | null, ref);
  return out;
};

const toEvidence = (raw: unknown, segments: Map<number, DemoSegment>, where: string): Evidence[] => {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`Demo summary ${where}: evidence must list at least one idx`);
  return raw.map((idx) => {
    const segment = typeof idx === "number" ? segments.get(idx) : undefined;
    if (!segment) throw new Error(`Demo summary ${where}: evidence idx ${String(idx)} is not a segment`);
    return { idx: segment.idx, speaker: segment.speaker, startMs: segment.startMs };
  });
};

export interface BuildOptions {
  /** The seed time; createdAt = now - daysAgo (at 15:00 UTC). */
  now: Date;
  /** One timing per line, from the generated audio; estimated if absent. */
  timings?: SegmentTiming[];
}

export const meetingStartFor = (spec: DemoMeetingSpec, now: Date): Date => {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - spec.daysAgo);
  start.setUTCHours(15, 0, 0, 0);
  return start;
};

export const buildDemoMeeting = (spec: DemoMeetingSpec, options: BuildOptions): DemoMeeting => {
  const timings = options.timings ?? estimateTimings(spec.lines);
  if (timings.length !== spec.lines.length) {
    throw new Error(`Demo ${spec.key}: ${timings.length} timings for ${spec.lines.length} lines`);
  }

  const speakers = speakersOf(spec);
  const labelOf = new Map(speakers.map((s) => [s.displayName, s.label]));
  const createdAt = meetingStartFor(spec, options.now);

  const segments: DemoSegment[] = spec.lines.map(([speaker, text], idx) => ({
    idx,
    speaker,
    speakerLabel: labelOf.get(speaker)!,
    text,
    startMs: timings[idx].startMs,
    endMs: timings[idx].endMs,
    channel: speaker === spec.me ? "mic" : "remote",
    noiseLabel: (spec.noise[idx] ?? "substantive") as NoiseLabel,
  }));
  const byIdx = new Map(segments.map((s) => [s.idx, s]));

  const body = resolveBody(spec.summary, byIdx, createdAt, spec.key) as Omit<
    SummaryV2,
    "schemaVersion" | "mode" | "modeSetting" | "detectedMode" | "prompts" | "stats"
  >;

  const summary: SummaryV2 = {
    schemaVersion: 2,
    mode: spec.mode,
    modeSetting: spec.mode,
    detectedMode: null,
    prompts: { demo: "demo: hand-written synthetic summary, no model call" },
    stats: {
      segments: segments.length,
      substantiveSegments: segments.filter((s) => s.noiseLabel === "substantive").length,
      chunks: 1,
      droppedItems: 0,
      timezone: "UTC",
      meetingStart: createdAt.toISOString(),
    },
    ...body,
  };

  const actionItems: DemoActionItem[] = summary.actionItems.map((entry, i) => ({
    task: entry.task,
    owner: entry.owner,
    assignedBy: entry.assignedBy,
    dueSpoken: entry.dueSpoken,
    dueDate: entry.dueDate,
    priority: entry.priority,
    status: spec.taskStatus?.[i] ?? "PENDING",
    confidence: entry.confidence,
    needsReview: entry.needsReview,
    evidence: entry.evidence,
  }));

  const last = segments[segments.length - 1];

  return {
    key: spec.key,
    title: spec.title,
    description: spec.description,
    mode: spec.mode,
    createdAt,
    durationSec: Math.ceil(last.endMs / 1000),
    segments,
    speakers,
    transcriptText: segments.map((s) => `[${clock(s.startMs)}] ${s.speaker}: ${s.text}`).join("\n"),
    summary,
    actionItems,
  };
};

export const buildDemoMeetings = (options: { now: Date; timings?: Partial<Record<string, SegmentTiming[]>> }): DemoMeeting[] =>
  DEMO_SPECS.map((spec) => buildDemoMeeting(spec, { now: options.now, timings: options.timings?.[spec.key] }));
