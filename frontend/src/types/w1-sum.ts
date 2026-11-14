/**
 * Summary schema version 2 (track w1-sum). Mirrors
 * backend/src/types/summary.ts by hand, like types/meeting.ts.
 *
 * Every segment reference is a TranscriptSegment.idx, never an array
 * position; live meetings have sparse idx values (seq * 1000 + i).
 */

import type { Priority, Sentiment } from "./meeting";

export const SUMMARY_MODES = [
  "GENERAL",
  "LECTURE",
  "INTERVIEW",
  "PROJECT",
  "ONE_ON_ONE",
] as const;

export type SummaryMode = (typeof SUMMARY_MODES)[number];

export type ModeSetting = SummaryMode | "AUTO";

export interface Evidence {
  idx: number;
  speaker: string;
  startMs: number;
}

export interface Sourced {
  evidence: Evidence[];
  confidence: number;
  needsReview: boolean;
}

export interface SummaryItem extends Sourced {
  text: string;
}

export interface DecisionItem extends Sourced {
  text: string;
  decidedBy: string | null;
}

export interface ActionItemV2 extends Sourced {
  task: string;
  owner: string | null;
  assignedBy: string | null;
  dueSpoken: string | null;
  dueDate: string | null;
  priority: Priority;
}

export interface DateItem extends Sourced {
  spoken: string;
  date: string | null;
  description: string;
}

export interface SpeakerPoint extends Sourced {
  speaker: string;
  text: string;
}

export interface GlossaryEntry extends Sourced {
  term: string;
  definition: string;
}

export interface ExamQuestion extends Sourced {
  question: string;
  reason: string;
}

export interface LectureSection {
  outline: SummaryItem[];
  definitions: GlossaryEntry[];
  formulas: (Sourced & { expression: string; meaning: string })[];
  examQuestions: {
    flaggedByLecturer: ExamQuestion[];
    likely: ExamQuestion[];
  };
  assignments: (Sourced & {
    task: string;
    dueSpoken: string | null;
    dueDate: string | null;
  })[];
  studyChecklist: SummaryItem[];
}

export interface InterviewSection {
  qa: (Sourced & { question: string; answerSummary: string })[];
  followUps: SummaryItem[];
  strengths: SummaryItem[];
  concerns: SummaryItem[];
  nextSteps: SummaryItem[];
  struggledWith: SummaryItem[];
}

export interface ProjectSection {
  people: {
    name: string;
    done: SummaryItem[];
    next: SummaryItem[];
    blockers: SummaryItem[];
  }[];
  risks: SummaryItem[];
}

export interface OneOnOneSection {
  feedback: SpeakerPoint[];
  commitments: (Sourced & { who: string; text: string })[];
  nextTopics: SummaryItem[];
}

export interface DetectedMode {
  mode: SummaryMode;
  confidence: number;
  reason: string;
}

export interface SummaryV2 {
  schemaVersion: 2;
  mode: SummaryMode;
  modeSetting: ModeSetting;
  detectedMode: DetectedMode | null;
  tldr: string;
  keyPoints: SummaryItem[];
  decisions: DecisionItem[];
  actionItems: ActionItemV2[];
  dates: DateItem[];
  openQuestions: SummaryItem[];
  whoSaidWhat: SpeakerPoint[];
  glossary: GlossaryEntry[];
  nextSessionPrep: SummaryItem[];
  keywords: string[];
  sentiment: { overall: Sentiment; rationale: string };
  sections: {
    lecture?: LectureSection;
    interview?: InterviewSection;
    project?: ProjectSection;
    oneOnOne?: OneOnOneSection;
  };
}

/** An ActionItem row with the v2 fields. */
export interface ActionItemRow {
  id: string;
  meetingId: string;
  task: string;
  owner: string | null;
  dueDate: string | null;
  priority: Priority | string;
  status: "PENDING" | "COMPLETED" | string;
  dueSpoken?: string | null;
  assignedBy?: string | null;
  confidence?: number | null;
  evidence?: Evidence[] | null;
  needsReview?: boolean;
  completedAt?: string | null;
  createdAt: string;
  meeting?: { id: string; title: string; createdAt: string };
}

export interface SummaryReview {
  modeSetting: ModeSetting;
  summaryMode: SummaryMode | null;
  detectedMode: DetectedMode | null;
  actionItems: ActionItemRow[];
}

export interface ResummarizeResult {
  summary: { id: string; content: string; data: unknown };
  actionItems: ActionItemRow[];
}

export type ReviewAction = "accept" | "edit" | "reject";

export interface ActionItemEdit {
  task?: string;
  owner?: string | null;
  dueSpoken?: string | null;
  priority?: Priority;
}
