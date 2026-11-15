import { isSummaryV2, type Evidence, type SummaryV2 } from "../../types/summary";
import { formatTimestamp } from "../../types/segment";
import { readSinceLastTime } from "../series/sinceLastTime";

/**
 * A meeting as an export: a neutral document (title, sections of
 * bullet items, optional transcript) that the Markdown and PDF renderers
 * both draw from, so the two never disagree.
 *
 * Rules (from the brief):
 * - Names, not ids: people are their display names, segment references
 *   become "Speaker at 12:34". No database id appears anywhere.
 * - Noise is left out: transcript segments the CLEAN pass labelled
 *   small_talk / logistics / filler / off_topic are dropped.
 * - Rejected items are left out: action items come from the ActionItem
 *   rows (a rejected item's row is deleted), minus any task text a
 *   human rejected; dismissed "Since last time" suggestions are dropped.
 */

export interface ExportItem {
  text: string;
  /** Owner, due date, "who said it at what time". */
  meta: string[];
}

export interface ExportSection {
  heading: string;
  items: ExportItem[];
}

export interface ExportDocument {
  title: string;
  /** "Tuesday 14 November 2026, 45 min" */
  subtitle: string;
  series: string | null;
  tldr: string | null;
  sections: ExportSection[];
  transcript: { at: string; speaker: string; text: string }[] | null;
}

export interface ExportInput {
  meeting: {
    title: string;
    createdAt: Date;
    startedAt: Date | null;
    durationSec: number | null;
    mode: string;
    seriesName: string | null;
  };
  summaryData: unknown;
  actionItems: {
    task: string;
    owner: string | null;
    dueDate: string | null;
    dueSpoken: string | null;
    status: string;
    needsReview: boolean;
  }[];
  /** Task texts a human rejected (w1-sum corrections). */
  rejectedTasks: string[];
  segments: { startMs: number; speaker: string; text: string; channel: string | null; noiseLabel: string | null }[];
  /** The owner's label for their own (mic) segments. */
  meLabel: string;
  /** The default label ("You") stored on older mic segments. */
  defaultMeLabel: string;
  timezone: string | null;
  includeTranscript: boolean;
}

const NOISE = new Set(["small_talk", "logistics", "filler", "off_topic"]);

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

const formatDate = (date: Date, timezone: string | null) => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: timezone ?? "UTC",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

const humanize = (mode: string) =>
  mode.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const speakerName = (
  speaker: string,
  channel: string | null,
  meLabel: string,
  defaultMeLabel: string
) => (channel === "mic" && (speaker === defaultMeLabel || !speaker.trim()) ? meLabel : speaker);

const evidenceMeta = (evidence: unknown, input: ExportInput): string[] => {
  if (!Array.isArray(evidence) || evidence.length === 0) return [];
  const first = evidence[0] as Partial<Evidence>;
  if (typeof first?.startMs !== "number") return [];
  // Evidence stores the label shown when it was written; the default
  // "You" becomes the owner's current display name.
  const who =
    typeof first.speaker === "string" && first.speaker
      ? first.speaker === input.defaultMeLabel
        ? input.meLabel
        : first.speaker
      : null;
  return [who ? `${who} at ${formatTimestamp(first.startMs)}` : `at ${formatTimestamp(first.startMs)}`];
};

const items = <T extends { evidence?: unknown }>(
  list: T[] | undefined,
  text: (item: T) => string,
  input: ExportInput,
  extra: (item: T) => (string | null | undefined)[] = () => []
): ExportItem[] =>
  (list ?? []).flatMap((item) => {
    const value = text(item)?.trim();
    if (!value) return [];
    return [
      {
        text: value,
        meta: [...extra(item).filter((m): m is string => Boolean(m)), ...evidenceMeta(item.evidence, input)],
      },
    ];
  });

const section = (heading: string, list: ExportItem[]): ExportSection[] =>
  list.length ? [{ heading, items: list }] : [];

const v2Sections = (summary: SummaryV2, input: ExportInput): ExportSection[] => {
  const s = summary.sections ?? {};
  const out: ExportSection[] = [
    ...section("Key points", items(summary.keyPoints, (i) => i.text, input)),
    ...section("Decisions", items(summary.decisions, (i) => i.text, input, (i) => [i.decidedBy ? `by ${i.decidedBy}` : null])),
    ...section(
      "Dates",
      items(summary.dates, (i) => `${i.spoken}: ${i.description}`, input, (i) => [i.date])
    ),
    ...section("Open questions", items(summary.openQuestions, (i) => i.text, input)),
    ...section("Prepare for next time", items(summary.nextSessionPrep, (i) => i.text, input)),
  ];

  if (s.lecture) {
    out.push(
      ...section("Outline", items(s.lecture.outline, (i) => i.text, input)),
      ...section("Definitions", items(s.lecture.definitions, (i) => `${i.term}: ${i.definition}`, input)),
      ...section("Assignments", items(s.lecture.assignments, (i) => i.task, input, (i) => [i.dueSpoken])),
      ...section(
        "Likely exam questions",
        items([...(s.lecture.examQuestions?.flaggedByLecturer ?? []), ...(s.lecture.examQuestions?.likely ?? [])], (i) => i.question, input)
      )
    );
  }
  if (s.interview) {
    out.push(
      ...section("Questions and answers", items(s.interview.qa, (i) => `${i.question} — ${i.answerSummary}`, input)),
      ...section("Next steps", items(s.interview.nextSteps, (i) => i.text, input))
    );
  }
  if (s.project) {
    for (const person of s.project.people ?? []) {
      out.push(
        ...section(`${person.name}: done`, items(person.done, (i) => i.text, input)),
        ...section(`${person.name}: next`, items(person.next, (i) => i.text, input)),
        ...section(`${person.name}: blockers`, items(person.blockers, (i) => i.text, input))
      );
    }
    out.push(...section("Risks", items(s.project.risks, (i) => i.text, input)));
  }
  if (s.oneOnOne) {
    out.push(
      ...section("Commitments", items(s.oneOnOne.commitments, (i) => `${i.who}: ${i.text}`, input)),
      ...section("Next topics", items(s.oneOnOne.nextTopics, (i) => i.text, input))
    );
  }
  return out;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())) : [];

const legacySections = (data: Record<string, unknown>): ExportSection[] => [
  ...section("Decisions", strings(data.keyDecisions).map((text) => ({ text, meta: [] }))),
  ...section(
    "Dates",
    (Array.isArray(data.importantDates) ? data.importantDates : []).flatMap((entry) => {
      const e = entry as { date?: unknown; description?: unknown };
      return typeof e?.description === "string" ? [{ text: `${e.date ?? ""}: ${e.description}`.replace(/^: /, ""), meta: [] }] : [];
    })
  ),
  ...section("Open questions", strings(data.openQuestions).map((text) => ({ text, meta: [] }))),
  ...section("Follow-ups", strings(data.followUps).map((text) => ({ text, meta: [] }))),
];

export const buildExport = (input: ExportInput): ExportDocument => {
  const data = input.summaryData;
  const v2 = isSummaryV2(data) ? data : null;
  const legacy = !v2 && data && typeof data === "object" ? (data as Record<string, unknown>) : null;

  const rejected = new Set(input.rejectedTasks.map(normalize));
  const tasks: ExportItem[] = input.actionItems
    .filter((item) => !rejected.has(normalize(item.task)))
    .map((item) => ({
      text: item.task,
      meta: [
        item.owner ? `owner: ${item.owner}` : "no owner",
        item.dueSpoken || item.dueDate ? `due: ${item.dueSpoken ?? item.dueDate}` : null,
        item.status === "COMPLETED" ? "done" : null,
        item.needsReview ? "to confirm" : null,
      ].filter((m): m is string => Boolean(m)),
    }));

  const since = readSinceLastTime((data as Record<string, unknown> | null)?.sinceLastTime);
  const sinceItems: ExportItem[] = (since?.items ?? [])
    .filter((item) => item.resolution !== "dismissed")
    .map((item) => ({
      text: item.task,
      meta: [
        item.status === "done" ? "done" : item.status === "still_open" ? "still open" : "not mentioned",
        item.owner ? `owner: ${item.owner}` : null,
        `from "${item.fromMeeting.title}"`,
        item.note,
      ].filter((m): m is string => Boolean(m)),
    }));

  const started = input.meeting.startedAt ?? input.meeting.createdAt;
  const minutes = input.meeting.durationSec ? Math.max(1, Math.round(input.meeting.durationSec / 60)) : null;

  return {
    title: input.meeting.title,
    subtitle: [
      formatDate(started, input.timezone),
      minutes ? `${minutes} min` : null,
      input.meeting.mode && input.meeting.mode !== "AUTO" ? humanize(input.meeting.mode) : null,
    ]
      .filter(Boolean)
      .join(", "),
    series: input.meeting.seriesName,
    tldr: v2?.tldr?.trim() || (typeof legacy?.executiveSummary === "string" ? legacy.executiveSummary.trim() : null) || null,
    sections: [
      ...section("Since last time", sinceItems),
      ...section("Action items", tasks),
      ...(v2 ? v2Sections(v2, input) : legacy ? legacySections(legacy) : []),
    ],
    transcript: input.includeTranscript
      ? input.segments
          .filter((segment) => !NOISE.has(segment.noiseLabel ?? ""))
          .map((segment) => ({
            at: formatTimestamp(segment.startMs),
            speaker: speakerName(segment.speaker, segment.channel, input.meLabel, input.defaultMeLabel),
            text: segment.text.trim(),
          }))
          .filter((line) => line.text)
      : null,
  };
};
