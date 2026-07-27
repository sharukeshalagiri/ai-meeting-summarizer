export type MeetingStatus =
  | "CREATED"
  | "PROCESSING"
  | "TRANSCRIBED"
  | "COMPLETED"
  | "FAILED";

export interface Transcript {
  id: string;
  content: string;
}

export interface ActionItem {
  task: string;
  owner: string | null;
  dueDate: string | null;
}

export interface ImportantDate {
  date: string;
  description: string;
}

export interface StructuredSummary {
  executiveSummary: string;
  keyDecisions: string[];
  actionItems: ActionItem[];
  importantDates: ImportantDate[];
  followUps: string[];
}

export interface Summary {
  id: string;
  /** Markdown rendering; always present. */
  content: string;
  /** Null for summaries created before structured output existed. */
  data?: StructuredSummary | null;
}

export interface Meeting {
  id: string;
  title: string;
  description: string | null;
  status: MeetingStatus | string;
  createdAt: string;

  transcript?: Transcript | null;

  summary?: Summary | null;
}
