import type {
  DetectedMode,
  ModeSetting,
  SummaryMode,
  SummaryV2,
} from "../../types/w1-sum";

/**
 * Helpers for summary schema v2: version detection, a defensive reader
 * (stored JSON is not trusted to be complete), and small formatters.
 * Kept in a .ts file so the .tsx files export only components.
 */

export const isSummaryV2 = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { schemaVersion?: unknown }).schemaVersion === 2;

type Raw = Record<string, unknown>;

const obj = (value: unknown): Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : {};

/** Items without an evidence array get an empty one. */
const list = <T>(value: unknown): T[] =>
  Array.isArray(value)
    ? (value.map((entry) =>
        typeof entry === "object" && entry !== null
          ? {
              ...(entry as Raw),
              evidence: Array.isArray((entry as Raw).evidence)
                ? (entry as Raw).evidence
                : [],
            }
          : entry
      ) as T[])
    : [];

/** Reads a stored v2 summary, filling any missing list with []. */
export const readSummaryV2 = (value: unknown): SummaryV2 | null => {
  if (!isSummaryV2(value)) return null;

  const raw = obj(value);
  const sections = obj(raw.sections);
  const lecture = sections.lecture ? obj(sections.lecture) : null;
  const interview = sections.interview ? obj(sections.interview) : null;
  const project = sections.project ? obj(sections.project) : null;
  const oneOnOne = sections.oneOnOne ? obj(sections.oneOnOne) : null;
  const sentiment = obj(raw.sentiment);

  return {
    schemaVersion: 2,
    mode: (raw.mode as SummaryMode) ?? "GENERAL",
    modeSetting: (raw.modeSetting as ModeSetting) ?? "AUTO",
    detectedMode: (raw.detectedMode as DetectedMode | null) ?? null,
    tldr: typeof raw.tldr === "string" ? raw.tldr : "",
    keyPoints: list(raw.keyPoints),
    decisions: list(raw.decisions),
    actionItems: list(raw.actionItems),
    dates: list(raw.dates),
    openQuestions: list(raw.openQuestions),
    whoSaidWhat: list(raw.whoSaidWhat),
    glossary: list(raw.glossary),
    nextSessionPrep: list(raw.nextSessionPrep),
    keywords: Array.isArray(raw.keywords)
      ? raw.keywords.filter((k): k is string => typeof k === "string")
      : [],
    sentiment: {
      overall: (sentiment.overall as SummaryV2["sentiment"]["overall"]) ?? "NEUTRAL",
      rationale: typeof sentiment.rationale === "string" ? sentiment.rationale : "",
    },
    sections: {
      ...(lecture
        ? {
            lecture: {
              outline: list(lecture.outline),
              definitions: list(lecture.definitions),
              formulas: list(lecture.formulas),
              examQuestions: {
                flaggedByLecturer: list(obj(lecture.examQuestions).flaggedByLecturer),
                likely: list(obj(lecture.examQuestions).likely),
              },
              assignments: list(lecture.assignments),
              studyChecklist: list(lecture.studyChecklist),
            },
          }
        : {}),
      ...(interview
        ? {
            interview: {
              qa: list(interview.qa),
              followUps: list(interview.followUps),
              strengths: list(interview.strengths),
              concerns: list(interview.concerns),
              nextSteps: list(interview.nextSteps),
              struggledWith: list(interview.struggledWith),
            },
          }
        : {}),
      ...(project
        ? {
            project: {
              people: (Array.isArray(project.people) ? project.people : []).map(
                (person) => {
                  const p = obj(person);
                  return {
                    name: typeof p.name === "string" ? p.name : "",
                    done: list(p.done),
                    next: list(p.next),
                    blockers: list(p.blockers),
                  };
                }
              ),
              risks: list(project.risks),
            },
          }
        : {}),
      ...(oneOnOne
        ? {
            oneOnOne: {
              feedback: list(oneOnOne.feedback),
              commitments: list(oneOnOne.commitments),
              nextTopics: list(oneOnOne.nextTopics),
            },
          }
        : {}),
    },
  };
};

export const MODE_LABELS: Record<ModeSetting, string> = {
  AUTO: "Auto-detect",
  GENERAL: "General",
  LECTURE: "Lecture",
  INTERVIEW: "Interview",
  PROJECT: "Project",
  ONE_ON_ONE: "1:1",
};

/** m:ss or h:mm:ss, matching the transcript's timestamps. */
export const formatOffset = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the viewer's zone as YYYY-MM-DD. */
export const todayIso = (now = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** True for a resolved date before today; free text is never overdue. */
export const isOverdue = (dueDate: string | null | undefined, now = new Date()) =>
  !!dueDate && ISO_DATE.test(dueDate) && dueDate < todayIso(now);

/** "Fri, Nov 13" for a resolved date; free text is returned as is. */
export const formatDue = (dueDate: string): string => {
  if (!ISO_DATE.test(dueDate)) return dueDate;

  const [year, month, day] = dueDate.split("-").map(Number);

  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

/**
 * Task-board order, matching the backend's sortByDueDate: open before
 * done, then resolved due date (soonest first), then undated items
 * newest first. Free-text legacy dates count as undated. Re-applied on
 * the client so a row toggled in place moves to where a reload puts it.
 */
export const sortByDue = <
  T extends { status: string; dueDate: string | null; createdAt: string },
>(
  items: T[]
): T[] => {
  const dated = (item: T) =>
    item.dueDate && ISO_DATE.test(item.dueDate) ? item.dueDate : null;

  return [...items].sort((a, b) => {
    const doneA = a.status === "COMPLETED" ? 1 : 0;
    const doneB = b.status === "COMPLETED" ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;

    const dueA = dated(a);
    const dueB = dated(b);
    if (dueA && dueB && dueA !== dueB) return dueA < dueB ? -1 : 1;
    if (dueA && !dueB) return -1;
    if (!dueA && dueB) return 1;

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
};
