/** Accounts, devices, series and exports (backend w4-acct). Kept in sync by hand. */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export type RetentionPolicy = "KEEP" | "AFTER_PROCESSING" | "AFTER_DAYS";

export interface Account extends AuthUser {
  createdAt: string;
  displayName: string | null;
  timezone: string | null;
  defaultMode: string;
  transcriptionProvider: string | null;
  glossary: string[];
  audioRetention: RetentionPolicy;
  audioRetentionDays: number | null;
  /** What mic segments are labelled: displayName or "You". */
  meLabel: string;
  options: {
    modes: string[];
    transcriptionProviders: string[];
    serverTranscriptionProvider: string;
    retentionPolicies: RetentionPolicy[];
    signupEnabled: boolean;
    emailEnabled: boolean;
  };
}

export type DeviceKind = "EXTENSION" | "DESKTOP" | "OTHER";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface SeriesSummary {
  id: string;
  name: string;
  createdAt: string;
  meetingCount: number;
  lastMeeting: { id: string; title: string; createdAt: string } | null;
}

export type SinceStatus = "done" | "still_open" | "not_mentioned";

export interface SinceLastTimeItem {
  actionItemId: string;
  task: string;
  owner: string | null;
  dueSpoken: string | null;
  fromMeeting: { id: string; title: string; createdAt: string };
  status: SinceStatus;
  note: string | null;
  evidence: { idx: number; startMs: number; speaker: string }[];
  suggestedStatus: "COMPLETED" | null;
  resolution: "applied" | "dismissed" | null;
}

export interface SinceLastTime {
  version: 1;
  seriesId: string;
  generatedAt: string;
  items: SinceLastTimeItem[];
}

export interface PrepOpenItem {
  id: string;
  task: string;
  owner: string | null;
  dueDate: string | null;
  dueSpoken: string | null;
  needsReview: boolean;
  meeting: { id: string; title: string; createdAt: string };
}

export interface Prep {
  series: { id: string; name: string };
  meetings: { id: string; title: string; createdAt: string; status: string }[];
  openItems: PrepOpenItem[];
  latest: {
    id: string;
    title: string;
    createdAt: string;
    tldr: string | null;
    decisions: string[];
    openQuestions: string[];
    nextSessionPrep: string[];
    sinceLastTime: SinceLastTime | null;
  } | null;
}

/** Fields the meeting row gained with accounts. */
export interface MeetingAccountFields {
  seriesId?: string | null;
  audioDeletedAt?: string | null;
}
