import fs from "fs/promises";
import { Prisma } from "@prisma/client";

/**
 * In-memory stand-ins for the repositories and upstream services the
 * live capture path touches, so contract tests run without a database,
 * Whisper, or Gemini. Each test calls reset().
 */

interface Session {
  id: string;
  meetingId: string;
  status: string;
  platform: string | null;
  source: string | null;
  hints: string[];
  roster: string[];
  chunkCount: number;
  elapsedMs: number;
  lastRollingAtMs: number;
}

interface Chunk {
  id: string;
  sessionId: string;
  seq: number;
  path: string;
  startOffsetMs: number;
  durationMs: number;
  channelLayout: string;
  status: string;
  error: string | null;
  segmentCount: number;
  result: Prisma.JsonValue | null;
}

interface Segment {
  meetingId: string;
  idx: number;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  channel?: string | null;
  words?: unknown;
}

export const store = {
  sessions: new Map<string, Session>(),
  chunks: [] as Chunk[],
  segments: [] as Segment[],
  meetings: new Map<string, { id: string; mode: string; status: string }>(),
  transcribeCalls: 0,
  /** The 3rd argument of every transcribeAudioDetailed call. */
  transcribeOptions: [] as unknown[],
  /** When true, fake segments carry channel "remote" and word timings. */
  withWords: false,
  /** Meetings startSummary was called for. */
  summariesStarted: [] as string[],
  /** When set, the next transcription waits for this promise. */
  gate: null as Promise<void> | null,
  failNext: false,
};

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

export const reset = () => {
  store.sessions.clear();
  store.chunks = [];
  store.segments = [];
  store.meetings.clear();
  store.transcribeCalls = 0;
  store.transcribeOptions = [];
  store.withWords = false;
  store.summariesStarted = [];
  store.gate = null;
  store.failNext = false;
};

export const meetingService = {
  createMeeting: async (input: { title: string; mode?: string }) => {
    const meeting = {
      id: nextId("meeting"),
      title: input.title,
      mode: input.mode ?? "AUTO",
      status: "CREATED",
    };
    store.meetings.set(meeting.id, meeting);
    return meeting;
  },
  startSummary: async (meetingId: string) => {
    store.summariesStarted.push(meetingId);
    return { meetingId, status: "PROCESSING", processingStage: "SUMMARIZING" };
  },
};

export const meetingRepo = {
  markStarted: async (id: string) => {
    const meeting = store.meetings.get(id)!;
    meeting.status = "LIVE";
    return meeting;
  },
  markEnded: async () => undefined,
  updateStatus: async () => undefined,
};

export const liveSessionRepo = {
  create: async (data: {
    meetingId: string;
    platform: string | null;
    source?: string | null;
    hints?: string[];
  }) => {
    const session: Session = {
      id: nextId("session"),
      meetingId: data.meetingId,
      status: "ACTIVE",
      platform: data.platform,
      source: data.source ?? null,
      hints: data.hints ?? [],
      roster: [],
      chunkCount: 0,
      elapsedMs: 0,
      lastRollingAtMs: 0,
    };
    store.sessions.set(session.id, session);
    return session;
  },
  findById: async (id: string) => store.sessions.get(id) ?? null,
  setRoster: async (id: string, roster: string[]) => {
    const session = store.sessions.get(id)!;
    session.roster = roster;
    return session;
  },
  recordChunk: async (id: string, durationMs: number) => {
    const session = store.sessions.get(id)!;
    session.chunkCount += 1;
    session.elapsedMs += durationMs;
    return session;
  },
  recordContractChunk: async (id: string, endMs: number) => {
    const session = store.sessions.get(id)!;
    session.chunkCount += 1;
    session.elapsedMs = Math.max(session.elapsedMs, endMs);
    return { ...session };
  },
  end: async (id: string) => {
    store.sessions.get(id)!.status = "ENDED";
  },
  markRollingAt: async () => undefined,
  addRollingSummary: async () => undefined,
};

export const liveChunkRepo = {
  findBySeq: async (sessionId: string, seq: number) =>
    store.chunks.find((c) => c.sessionId === sessionId && c.seq === seq) ??
    null,
  claim: async (data: Omit<Chunk, "id" | "status" | "error" | "segmentCount" | "result">) => {
    if (store.chunks.some((c) => c.sessionId === data.sessionId && c.seq === data.seq)) {
      return null;
    }
    const chunk: Chunk = {
      ...data,
      id: nextId("chunk"),
      status: "PROCESSING",
      error: null,
      segmentCount: 0,
      result: null,
    };
    store.chunks.push(chunk);
    return chunk;
  },
  reclaimFailed: async (id: string, data: Partial<Chunk>) => {
    const chunk = store.chunks.find((c) => c.id === id);
    if (!chunk || chunk.status !== "FAILED") return false;
    Object.assign(chunk, data, { status: "PROCESSING", error: null });
    return true;
  },
  markTranscribed: async (id: string, segmentCount: number, result: Prisma.JsonValue) => {
    const chunk = store.chunks.find((c) => c.id === id)!;
    Object.assign(chunk, {
      status: "TRANSCRIBED",
      segmentCount,
      result: JSON.parse(JSON.stringify(result)),
    });
    return chunk;
  },
  markFailed: async (id: string, error: string) => {
    const chunk = store.chunks.find((c) => c.id === id)!;
    Object.assign(chunk, { status: "FAILED", error });
    return chunk;
  },
};

const segmentsOf = (meetingId: string) =>
  store.segments
    .filter((s) => s.meetingId === meetingId)
    .sort((a, b) => a.idx - b.idx);

export const segmentRepo = {
  findByMeetingId: async (meetingId: string) => segmentsOf(meetingId),
  findRecentByMeetingId: async (meetingId: string, limit: number) =>
    segmentsOf(meetingId).slice(-limit),
  findByIdxRange: async (meetingId: string, from: number, to: number) =>
    segmentsOf(meetingId).filter((s) => s.idx >= from && s.idx < to),
  appendForMeeting: async (meetingId: string, segments: Omit<Segment, "meetingId" | "idx">[]) => {
    const existing = store.segments.filter((s) => s.meetingId === meetingId).length;
    segments.forEach((s, i) =>
      store.segments.push({ ...s, meetingId, idx: existing + i })
    );
    return segments.length;
  },
  insertAtIdx: async (meetingId: string, segments: Omit<Segment, "meetingId">[]) => {
    let count = 0;
    for (const s of segments) {
      if (store.segments.some((x) => x.meetingId === meetingId && x.idx === s.idx)) continue;
      store.segments.push({ ...s, meetingId });
      count++;
    }
    return count;
  },
};

/**
 * Fake Whisper: the uploaded file's text is split on "|" into one-second
 * segments, shifted by offsetMs, so tests control the transcript.
 */
export const speechService = {
  transcribeAudioDetailed: async (
    filePath: string,
    offsetMs = 0,
    options?: unknown
  ) => {
    store.transcribeCalls++;
    store.transcribeOptions.push(options);

    if (store.gate) await store.gate;

    if (store.failNext) {
      store.failNext = false;
      throw new Error("fake transcription failure");
    }

    const parts = (await fs.readFile(filePath, "utf8"))
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);

    return {
      text: parts.join(" "),
      segments: parts.map((text, i) => {
        const startMs = offsetMs + i * 1000;
        const segment = { text, startMs, endMs: startMs + 1000 };
        if (!store.withWords) return segment;

        const words = text.split(/\s+/);
        const step = Math.floor(1000 / words.length);
        return {
          ...segment,
          channel: "remote" as const,
          words: words.map((w, k) => ({
            w,
            startMs: startMs + k * step,
            endMs: startMs + (k + 1) * step,
          })),
        };
      }),
      durationMs: parts.length * 1000,
      language: "en",
    };
  },
};

export const diarizationService = {
  diarizeSegments: async (segments: { text: string; startMs: number; endMs: number }[]) =>
    segments.map((s) => ({ ...s, speaker: "Speaker 1" })),
};

export const summaryService = {
  generateRollingSummary: async () => ({}),
};
