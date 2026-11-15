import type { Page, Route } from "@playwright/test";
import { buildDemoMeetings, DEMO_SPECS, estimateTimings, LINE_GAP_MS, speakersOf } from "../../backend/src/demo/build";
import { assembleStereo, toneClip } from "../../backend/src/demo/audio/wav";
import type { DemoMeeting } from "../../backend/src/demo/types";
import { API_BASE } from "../tests/mockApi";

/**
 * The demo account as the backend serves it after `demo:seed`, answered
 * in the browser. The meetings come from the seed's own builder, so the
 * screenshots show exactly the seeded summaries, chips and transcripts.
 * The audio is the seed's tone fallback (no text-to-speech here): it is
 * only there so the player and the ▶ chips render as they do with audio.
 */

const NOW = new Date("2026-11-15T12:00:00Z");

const recordings = new Map<string, Buffer>();
const timings: Record<string, { startMs: number; endMs: number }[]> = {};
for (const spec of DEMO_SPECS) {
  const index = new Map(speakersOf(spec).map((s, i) => [s.displayName, i]));
  const estimated = estimateTimings(spec.lines);
  const { wav, timings: real } = assembleStereo(
    spec.lines.map(([speaker], i) => ({
      clip: toneClip(estimated[i].endMs - estimated[i].startMs, index.get(speaker) ?? 0),
      mic: speaker === spec.me,
    })),
    LINE_GAP_MS
  );
  recordings.set(spec.key, wav);
  timings[spec.key] = real;
}

export const MEETINGS: DemoMeeting[] = buildDemoMeetings({ now: NOW, timings });
export const idOf = (key: string) => `demo-${key}`;

const iso = (date: Date) => date.toISOString();
const clock = (ms: number) => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const actionRows = (m: DemoMeeting) =>
  m.actionItems.map((item, i) => ({
    id: `${idOf(m.key)}-task-${i}`,
    meetingId: idOf(m.key),
    ...item,
    completedAt: item.status === "COMPLETED" ? iso(m.createdAt) : null,
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.createdAt),
    meeting: { id: idOf(m.key), title: m.title, createdAt: iso(m.createdAt) },
  }));

const meetingRow = (m: DemoMeeting) => ({
  id: idOf(m.key),
  title: m.title,
  description: m.description,
  status: "COMPLETED",
  source: "UPLOAD",
  platform: null,
  durationSec: m.durationSec,
  startedAt: iso(m.createdAt),
  endedAt: iso(new Date(m.createdAt.getTime() + m.durationSec * 1000)),
  createdAt: iso(m.createdAt),
  audioPath: `uploads/demo/${m.key}.ogg`,
  mode: m.mode,
  processingStage: "DONE",
  processingProgress: 100,
  processingError: null,
  audioDeletedAt: null,
  seriesId: null,
  transcript: { id: `${idOf(m.key)}-t`, content: m.transcriptText },
  summary: { id: `${idOf(m.key)}-s`, content: "", data: m.summary, sentiment: m.summary.sentiment.overall },
  actionItems: actionRows(m),
});

const speakerId = (m: DemoMeeting, label: string) => `${idOf(m.key)}-${label.replace(/\s+/g, "-")}`;

const segmentRows = (m: DemoMeeting) =>
  m.segments.map((s) => ({
    id: `${idOf(m.key)}-seg-${s.idx}`,
    idx: s.idx,
    speaker: s.speaker,
    text: s.text,
    startMs: s.startMs,
    endMs: s.endMs,
    channel: s.channel,
    noiseLabel: s.noiseLabel,
    speakerId: speakerId(m, s.speakerLabel),
    words: null,
    timestamp: clock(s.startMs),
  }));

const speakerRows = (m: DemoMeeting) =>
  m.speakers.map((s) => ({
    key: speakerId(m, s.label),
    speakerId: speakerId(m, s.label),
    label: s.label,
    name: s.displayName,
    isMe: s.isMe,
    source: "DIARIZATION",
    segmentCount: m.segments.filter((seg) => seg.speakerLabel === s.label).length,
    suggestion: null,
  }));

const account = {
  id: "demo-user",
  name: "Demo visitor",
  email: "demo@example.com",
  createdAt: iso(NOW),
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
    signupEnabled: false,
    emailEnabled: false,
  },
};

export const mockDemoApi = async (page: Page) => {
  let signedIn = false;
  const headers: Record<string, string> = {};
  const cors = (origin: string | undefined) =>
    Object.assign(headers, {
      "access-control-allow-origin": origin ?? "*",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, range",
      "access-control-expose-headers": "content-disposition, content-range, accept-ranges",
      vary: "Origin",
    });

  const ok = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify({ success: true, message: "OK", data }) });

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    cors(request.headers()["origin"]);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });

    const path = new URL(request.url()).pathname.replace(/^\/api/, "").replace(/\/$/, "");
    const key = `${request.method()} ${path}`;

    if (key === "GET /demo") return ok(route, { enabled: true, readOnly: true });
    if (key === "POST /demo/login") {
      signedIn = true;
      return ok(route, { user: { id: account.id, name: account.name, email: account.email }, meetingId: idOf("lecture") });
    }
    if (key === "GET /auth/me") {
      return signedIn
        ? ok(route, account)
        : route.fulfill({
            status: 401,
            headers,
            contentType: "application/json",
            body: JSON.stringify({ success: false, message: "Please sign in.", data: { signupEnabled: false } }),
          });
    }
    if (key === "GET /meetings") return ok(route, MEETINGS.map(meetingRow));
    if (key === "GET /action-items") return ok(route, MEETINGS.flatMap(actionRows));

    const match = /^\/meetings\/demo-(\w+)(\/.*)?$/.exec(path);
    const meeting = match && MEETINGS.find((m) => m.key === match[1]);
    if (meeting && request.method() === "GET") {
      switch (match![2] ?? "") {
        case "":
          return ok(route, meetingRow(meeting));
        case "/segments":
          return ok(route, segmentRows(meeting));
        case "/speakers":
          return ok(route, speakerRows(meeting));
        case "/summary-review":
          return ok(route, {
            modeSetting: meeting.mode,
            summaryMode: meeting.mode,
            detectedMode: null,
            actionItems: actionRows(meeting),
          });
        case "/audio":
          return route.fulfill({ status: 200, headers, contentType: "audio/wav", body: recordings.get(meeting.key)! });
        case "/events":
          return route.fulfill({
            status: 200,
            headers,
            contentType: "text/event-stream",
            body: `event: progress\ndata: ${JSON.stringify({ id: idOf(meeting.key), status: "COMPLETED", source: "UPLOAD", processingStage: "DONE", processingProgress: 100, processingError: null })}\n\nevent: end\ndata: {}\n\n`,
          });
      }
    }

    // Anything else a page asks for: empty, as for a fresh account.
    return request.method() === "GET"
      ? ok(route, [])
      : route.fulfill({
          status: 403,
          headers,
          contentType: "application/json",
          body: JSON.stringify({ success: false, message: "This is a read-only demo.", data: null }),
        });
  });
};
