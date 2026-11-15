import type { Page, Route } from "@playwright/test";

/**
 * In-browser stand-in for the backend API. Answers the upload flow with
 * the backend's { success, message, data } envelope and records every
 * call, so a test can assert the order the UI made them in. The summary
 * is a synthetic v2 summary (schemaVersion 2), like the pipeline's.
 */

export const MEETING_ID = "e2e-meeting-1";

/**
 * The API origin the frontend is built with (playwright.config.ts). Only
 * this origin is intercepted: a looser pattern such as //api// would
 * also catch Vite serving the module /src/api/api.ts.
 */
export const API_BASE = "http://127.0.0.1:9/api";

const now = "2026-11-09T15:00:00.000Z";
const evidence = (idx: number, speaker: string, startMs: number) => [{ idx, speaker, startMs }];
const sourced = (idx: number, speaker: string, startMs: number) => ({ evidence: evidence(idx, speaker, startMs), confidence: 0.9, needsReview: false });

export const SUMMARY_V2 = {
  schemaVersion: 2,
  mode: "PROJECT",
  modeSetting: "PROJECT",
  detectedMode: null,
  tldr: "The team chose Postgres full-text search for the beta and split the work.",
  keyPoints: [],
  decisions: [{ text: "Use Postgres full-text search", decidedBy: "Priya", ...sourced(1, "Marcus", 4000) }],
  actionItems: [
    {
      task: "Build the search endpoint",
      owner: "Marcus",
      assignedBy: null,
      dueSpoken: "by Friday",
      dueDate: "2026-11-13",
      priority: "HIGH",
      ...sourced(2, "Marcus", 9000),
    },
  ],
  dates: [],
  openQuestions: [],
  whoSaidWhat: [],
  glossary: [],
  nextSessionPrep: [],
  keywords: ["search"],
  sentiment: { overall: "POSITIVE", rationale: "" },
  sections: {},
  prompts: {},
  stats: { segments: 3, substantiveSegments: 3, chunks: 1, droppedItems: 0, timezone: "UTC", meetingStart: now },
};

const segments = [
  { id: "s0", idx: 0, speaker: "Priya", text: "Let's lock the search plan.", startMs: 0, endMs: 3500, timestamp: "0:00" },
  { id: "s1", idx: 1, speaker: "Marcus", text: "Postgres full-text search is fast enough.", startMs: 4000, endMs: 8500, timestamp: "0:04" },
  { id: "s2", idx: 2, speaker: "Marcus", text: "I'll build the search endpoint by Friday.", startMs: 9000, endMs: 13000, timestamp: "0:09" },
];

const actionItemRow = {
  id: "ai-1",
  meetingId: MEETING_ID,
  task: "Build the search endpoint",
  owner: "Marcus",
  dueDate: "2026-11-13T00:00:00.000Z",
  dueSpoken: "by Friday",
  priority: "HIGH",
  status: "PENDING",
  confidence: 0.9,
  needsReview: false,
  evidence: evidence(2, "Marcus", 9000),
  completedAt: null,
  createdAt: now,
};

/** What a re-summarize produces (a different TL;DR, to see it replaced). */
export const SUMMARY_V2_RESUMMARIZED = {
  ...SUMMARY_V2,
  tldr: "Re-summarized: Postgres full-text search for the beta; Marcus owns the endpoint.",
};

export interface MockOptions {
  title: string;
  /**
   * Make one pipeline step fail. "summarize" fails the queued job: the
   * progress stream reports processingStage FAILED with this message.
   */
  failStep?: "summarize";
  failMessage?: string;
  /** Start on an already summarized meeting (the meeting page). */
  summarized?: boolean;
  /**
   * POST /resummarize outlives its wait and returns { queued: true }
   * (w3-jobs); the result arrives over the progress stream.
   */
  resummarizeQueued?: boolean;
}

/** A text/event-stream body, as GET /meetings/:id/events sends it. */
const sse = (rows: unknown[]) =>
  rows.map((row) => `event: progress\ndata: ${JSON.stringify(row)}\n\n`).join("") + "event: end\ndata: {}\n\n";

export const mockApi = async (page: Page, options: MockOptions) => {
  const calls: string[] = [];
  let summarized = options.summarized ?? false;
  let summaryData: typeof SUMMARY_V2 = SUMMARY_V2;
  // The job that the next GET /events reports on.
  let pending: "process" | "resummarize" | null = null;

  const meeting = () => ({
    id: MEETING_ID,
    title: options.title,
    description: null,
    status: summarized ? "COMPLETED" : "CREATED",
    source: "UPLOAD",
    platform: null,
    durationSec: 13,
    startedAt: now,
    endedAt: null,
    createdAt: now,
    audioPath: "uploads/meetings/e2e.wav",
    mode: "PROJECT",
    processingStage: summarized ? "DONE" : null,
    processingProgress: null,
    processingError: null,
    transcript: { id: "t1", content: segments.map((s) => `${s.speaker}: ${s.text}`).join("\n") },
    summary: summarized ? { id: "sum1", content: `# TL;DR\n\n${summaryData.tldr}`, data: summaryData, sentiment: "POSITIVE" } : null,
    actionItems: summarized ? [actionItemRow] : [],
  });

  // The page (localhost) and the mocked API (127.0.0.1:9) are different
  // origins, so the browser applies CORS to fulfilled responses too.
  // The app sends credentials (w4-acct: session cookie), and a
  // credentialed response must name the origin and list headers
  // explicitly ("*" is not honoured then).
  const headers: Record<string, string> = {};
  const setCors = (requestOrigin: string | undefined) => {
    Object.assign(headers, {
      "access-control-allow-origin": requestOrigin ?? "*",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-expose-headers": "content-disposition",
      vary: "Origin",
    });
  };
  setCors(undefined);

  // w4-acct: the signed-in account (GET /auth/me) the Layout gate needs.
  const account = {
    id: "user-e2e",
    name: "E2E User",
    email: "e2e@example.com",
    createdAt: now,
    displayName: null,
    timezone: null,
    defaultMode: "AUTO",
    transcriptionProvider: null,
    glossary: [],
    audioRetention: "KEEP",
    audioRetentionDays: null,
    meLabel: "You",
    options: {
      modes: ["AUTO", "GENERAL", "LECTURE", "INTERVIEW", "PROJECT", "ONE_ON_ONE"],
      transcriptionProviders: ["local"],
      serverTranscriptionProvider: "local",
      retentionPolicies: ["KEEP", "AFTER_PROCESSING", "AFTER_DAYS"],
      signupEnabled: true,
      emailEnabled: false,
    },
  };

  const ok = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify({ success: true, message: "OK", data }) });
  const fail = (route: Route, status: number, message: string) =>
    route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify({ success: false, message, data: null }) });

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    setCors(request.headers()["origin"]);
    const url = new URL(request.url());
    const apiPath = url.pathname.replace(/^\/api/, "");
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const key = `${request.method()} ${apiPath}`;
    calls.push(key);
    const base = `/meetings/${MEETING_ID}`;

    switch (key) {
      case "GET /auth/me":
        return ok(route, account);
      case "POST /meetings":
        return ok(route, meeting(), 201);
      case `POST ${base}/audio`:
        return ok(route, meeting());
      case `POST ${base}/process`:
        // Same 202 body as meeting.service startProcessing (w3-jobs).
        pending = "process";
        return ok(route, { meetingId: MEETING_ID, status: "PROCESSING", processingStage: "TRANSCRIBING" }, 202);
      case `POST ${base}/resummarize`:
        if (!options.resummarizeQueued) {
          summaryData = SUMMARY_V2_RESUMMARIZED;
          return ok(route, { summary: meeting().summary, actionItems: [actionItemRow] });
        }
        pending = "resummarize";
        return ok(route, {
          queued: true,
          meetingId: MEETING_ID,
          status: "PROCESSING",
          processingStage: "SUMMARIZING",
          summary: null,
          actionItems: null,
        });
      case `GET ${base}/events`: {
        const row = (status: string, processingStage: string, processingError: string | null = null) => ({
          id: MEETING_ID,
          status,
          source: "UPLOAD",
          processingStage,
          processingProgress: null,
          processingError,
        });
        const job = pending;
        pending = null;

        if (job === "process" && options.failStep === "summarize") {
          const message = options.failMessage ?? "The AI service is temporarily overloaded.";
          return route.fulfill({
            status: 200,
            headers,
            contentType: "text/event-stream",
            body: sse([row("PROCESSING", "SUMMARIZING"), row("FAILED", "FAILED", `[SUMMARIZING/AI_UNAVAILABLE] ${message}`)]),
          });
        }
        if (job === "process") summarized = true;
        if (job === "resummarize") summaryData = SUMMARY_V2_RESUMMARIZED;

        // A re-summarize keeps status COMPLETED; only the stage moves.
        const running = job === "resummarize" ? row("COMPLETED", "SUMMARIZING") : row("PROCESSING", "SUMMARIZING");
        return route.fulfill({
          status: 200,
          headers,
          contentType: "text/event-stream",
          body: sse(job ? [running, row("COMPLETED", "DONE")] : [row(summarized ? "COMPLETED" : "CREATED", summarized ? "DONE" : "")]),
        });
      }
      case `GET ${base}`:
        return ok(route, meeting());
      case `GET ${base}/segments`:
        return ok(route, segments);
      case `GET ${base}/summary-review`:
        return ok(route, { modeSetting: "PROJECT", summaryMode: "PROJECT", detectedMode: null, actionItems: summarized ? [actionItemRow] : [] });
      case `GET ${base}/audio`:
        return route.fulfill({ status: 404, headers, body: "" });
      default:
        // Lists and anything else the pages may ask for: empty, not an error.
        return request.method() === "GET" ? ok(route, []) : fail(route, 404, `unmocked ${key}`);
    }
  });

  return { calls };
};
