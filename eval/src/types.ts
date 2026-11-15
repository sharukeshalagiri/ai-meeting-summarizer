/**
 * Shapes shared by the evaluation harness. The answer-key format is the
 * one in fixtures/transcripts/README.md; every field added for w2-eval is
 * optional so the original keys stay valid.
 */

export interface Segment {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface ExpectedItem {
  id: string;
  kind: string;
  match: string[];
  owner?: string | null;
  /** As spoken ("Friday"); null = the summary must not invent one. */
  dueDate?: string | null;
  /** w2-eval: the calendar date `dueDate` means, given the case's meetingStart/timezone. */
  dueResolved?: string | null;
  evidenceStartMs: number[];
}

export interface ForbiddenItem {
  id: string;
  kind: string;
  match: string[];
  reason: string;
}

export interface AnswerKey {
  transcript: string;
  mode: string;
  description?: string;
  /** w2-eval: the recording user's speaker name (whose perspective the summary takes). */
  me?: string;
  /** w2-eval: exact number of produced items expected for a kind, e.g. { actionItem: 0 }. */
  counts?: Record<string, number>;
  mustAppear: ExpectedItem[];
  /** w2-eval: allowed but not required; neutral for precision. */
  mayAppear?: ExpectedItem[];
  mustNotAppear: ForbiddenItem[];
}

export type CaseType = "synthetic" | "generated" | "ami" | "own";

/** One entry of eval/cases/index.json. */
export interface CaseEntry {
  id: string;
  type: CaseType;
  /** synthetic: answer key in fixtures/transcripts. */
  key?: string;
  /** generated: the generator that builds transcript + key. */
  generator?: string;
  /** ami: meeting id in eval/data/ami. */
  meeting?: string;
  /** ISO instant the meeting started; anchors relative dates. */
  meetingStart?: string;
  timezone?: string;
  /** Short cases first; the budget planner runs cases in this order. */
  priority?: number;
  /** own: the Meeting id whose Correction rows feed eval:import-corrections. */
  meetingId?: string;
  /** In the 2-case smoke run. */
  smoke?: boolean;
}

/** A case ready to run: transcript-based or audio-based. */
export interface LoadedCase {
  entry: CaseEntry;
  /** Transcript cases. */
  segments?: Segment[];
  key?: AnswerKey;
  /** Audio cases. */
  audioPath?: string;
  reference?: AudioReference;
  /** Length of the recording, for per-minute figures. */
  durationMs: number;
}

/** Ground truth for an audio case (AMI, own recordings). */
export interface AudioReference {
  /** Every reference word with its speaker, time ordered. */
  words: { speaker: string; text: string; startMs: number; endMs: number }[];
  /** Speaker name of the recording user (left channel). */
  me: string;
}

/** A summary item flattened for matching. */
export interface ProducedItem {
  /** Stable reference for reports and the judge, e.g. "actionItems[2]". */
  ref: string;
  /** Answer-key kind, or "other". */
  kind: string;
  /** All of the item's text fields joined; used for matching. */
  text: string;
  owner?: string | null;
  dueSpoken?: string | null;
  dueDate?: string | null;
  /** TranscriptSegment.idx values the item cites. */
  evidence: number[];
}

export type CaseStatus = "OK" | "INFRA_ERROR" | "BUDGET_STOP" | "PIPELINE_ERROR" | "SKIPPED";
