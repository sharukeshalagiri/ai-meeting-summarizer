import type { Page, Route } from "@playwright/test";

/**
 * In-browser stand-in for the backend API. Answers the upload flow with
 * the backend's { success, message, data } envelope and records every
 * call, so a test can assert the order the UI made them in. The summary
 * is a synthetic v2 summary (schemaVersion 2), like the pipeline's.
 */

export const MEETING_ID = "e2e-meeting-1";

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

export interface MockOptions {
  title: string;
  /** Make one step fail with a 502 and this message. */
  failStep?: "transcribe" | "summarize";
  failMessage?: string;
}

export const mockApi = async (page: Page, options: MockOptions) => {
  const calls: string[] = [];
  let summarized = false;

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
    summary: summarized ? { id: "sum1", content: `# TL;DR\n\n${SUMMARY_V2.tldr}`, data: SUMMARY_V2, sentiment: "POSITIVE" } : null,
    actionItems: summarized ? [actionItemRow] : [],
  });

  const ok = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ success: true, message: "OK", data }) });
  const fail = (route: Route, status: number, message: string) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ success: false, message, data: null }) });

  await page.route(/\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname.replace(/^.*?\/api/, "");
    const key = `${request.method()} ${apiPath}`;
    calls.push(key);
    const base = `/meetings/${MEETING_ID}`;

    switch (key) {
      case "POST /meetings":
        return ok(route, meeting(), 201);
      case `POST ${base}/audio`:
        return ok(route, meeting());
      case `POST ${base}/transcribe`:
        if (options.failStep === "transcribe") return fail(route, 502, options.failMessage ?? "Could not reach the transcription service.");
        return ok(route, { id: "t1", content: "" });
      case `POST ${base}/summarize`:
        if (options.failStep === "summarize") return fail(route, 502, options.failMessage ?? "The AI service is temporarily overloaded.");
        summarized = true;
        return ok(route, null, 202);
      case `GET ${base}`:
        return ok(route, meeting());
      case `GET ${base}/segments`:
        return ok(route, segments);
      case `GET ${base}/summary-review`:
        return ok(route, { modeSetting: "PROJECT", summaryMode: "PROJECT", detectedMode: null, actionItems: summarized ? [actionItemRow] : [] });
      case `GET ${base}/audio`:
        return route.fulfill({ status: 404, body: "" });
      default:
        // Lists and anything else the pages may ask for: empty, not an error.
        return request.method() === "GET" ? ok(route, []) : fail(route, 404, `unmocked ${key}`);
    }
  });

  return { calls };
};
