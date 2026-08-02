/** Mirrors backend/src/types — kept in sync by hand. */

export type MeetingStatus =
  | "CREATED"
  | "LIVE"
  | "PROCESSING"
  | "TRANSCRIBED"
  | "COMPLETED"
  | "FAILED";

export type MeetingSource = "UPLOAD" | "LIVE";

export type Platform =
  | "GOOGLE_MEET"
  | "ZOOM"
  | "MICROSOFT_TEAMS"
  | "OTHER";

export type Sentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED";

export type Priority = "HIGH" | "MEDIUM" | "LOW";

export interface Transcript {
  id: string;
  content: string;
}

/** A timestamped, speaker-attributed slice of the transcript. */
export interface Segment {
  id: string;
  idx: number;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  /** Server-rendered form of startMs, e.g. "12:34". */
  timestamp: string;
}

export interface ActionItem {
  task: string;
  owner: string | null;
  dueDate: string | null;
  priority: Priority;
}

/** A tracked action item row, as opposed to one inside a summary. */
export interface ActionItemRecord extends ActionItem {
  id: string;
  meetingId: string;
  status: "PENDING" | "COMPLETED";
  completedAt: string | null;
  createdAt: string;
  meeting?: {
    id: string;
    title: string;
    createdAt: string;
  };
}

export interface ImportantDate {
  date: string;
  description: string;
}

export interface DiscussionTopic {
  topic: string;
  summary: string;
}

export interface MeetingSentiment {
  overall: Sentiment;
  rationale: string;
}

export interface StructuredSummary {
  executiveSummary: string;
  keyDecisions: string[];
  actionItems: ActionItem[];
  importantDates: ImportantDate[];
  followUps: string[];

  risks: string[];
  blockers: string[];
  openQuestions: string[];
  discussionTopics: DiscussionTopic[];
  keywords: string[];
  sentiment: MeetingSentiment;
}

export interface Summary {
  id: string;
  /** Markdown rendering; always present. */
  content: string;
  /** Null for summaries created before structured output existed. */
  data?: StructuredSummary | null;
  sentiment?: Sentiment | null;
}

export interface Meeting {
  id: string;
  title: string;
  description: string | null;
  status: MeetingStatus | string;
  source: MeetingSource | string;
  platform: Platform | string | null;
  durationSec: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;

  transcript?: Transcript | null;
  summary?: Summary | null;
  actionItems?: ActionItemRecord[];
}

/* ---------- live capture ---------- */

export interface RollingSummaryData {
  headline: string;
  recentPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
}

export interface RollingSummary {
  id: string;
  atMs: number;
  data: RollingSummaryData;
  createdAt: string;
}

export interface LiveSession {
  id: string;
  meetingId: string;
  status: "ACTIVE" | "ENDED";
  platform: Platform | string | null;
  chunkCount: number;
  elapsedMs: number;
  startedAt: string;
  endedAt: string | null;
  rollingSummaries: RollingSummary[];
}

export interface LiveState {
  session: LiveSession;
  segments: Segment[];
}

export interface ChunkResult {
  sessionId: string;
  meetingId: string;
  elapsedMs: number;
  chunkCount: number;
  segments: {
    speaker: string;
    text: string;
    startMs: number;
    endMs: number;
  }[];
  rollingSummaryGenerated: boolean;
}

/* ---------- search and chat ---------- */

export interface SearchHit {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  score: number;
  timestamp: string;
}

export interface Citation {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  speaker: string;
  text: string;
  startMs: number;
  timestamp: string;
}

export interface ChatAnswer {
  answer: string;
  citations: Citation[];
  conversationId: string;
}

/* ---------- analytics ---------- */

export interface TrendEntry {
  label: string;
  count: number;
}

export interface DailyPoint {
  date: string;
  meetings: number;
  durationMin: number;
}

export interface Analytics {
  totals: {
    meetings: number;
    totalDurationSec: number;
    totalDurationMin: number;
    avgDurationSec: number;
    avgDurationMin: number;
    actionItems: number;
    completedActionItems: number;
    pendingActionItems: number;
    completionRate: number;
    decisions: number;
    risks: number;
    blockers: number;
    openQuestions: number;
  };
  meetingsByStatus: TrendEntry[];
  meetingsBySource: TrendEntry[];
  frequency: DailyPoint[];
  keywordTrends: TrendEntry[];
  topicTrends: TrendEntry[];
  sentimentBreakdown: TrendEntry[];
  sentimentTimeline: {
    date: string;
    meetingId: string;
    title: string;
    sentiment: Sentiment | string;
  }[];
  workload: TrendEntry[];
}
