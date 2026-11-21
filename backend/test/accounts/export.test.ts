import nodemailer from "nodemailer";
import request from "supertest";
import { createApp } from "../../src/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as exportRepo from "../../src/repositories/export.repository";
import { buildExport, type ExportInput } from "../../src/services/export/exportModel";
import { setTransportForTests } from "../../src/services/export/mailer";
import { toLatin1, toMarkdown, toPdf } from "../../src/services/export/render";

/**
 * Exports: names not ids, no noise, no rejected items; Markdown, PDF
 * and email. Email goes only to nodemailer's jsonTransport (a mock that
 * builds the message and sends nothing).
 */


// Read-time speaker names (speakers.service) look up profiles and
// corrections; none here, so responses pass through unchanged.
vi.mock("../../src/repositories/speakerProfile.repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findByMeetingId: async () => [],
}));

vi.mock("../../src/repositories/export.repository", () => ({ findForExport: vi.fn() }));
vi.mock("../../src/repositories/correction.repository", () => ({
  findByMeetingId: vi.fn(async () => [
    { kind: "ACTION_ITEM", targetId: "x", before: { task: "Buy snacks" }, after: { action: "reject" } },
  ]),
}));
vi.mock("../../src/repositories/segment.repository", () => ({
  findByMeetingId: vi.fn(async () => [
    { idx: 0, startMs: 0, speaker: "You", text: "Let's start with the budget.", channel: "mic", noiseLabel: "substantive" },
    { idx: 1, startMs: 5000, speaker: "Speaker 2", text: "Did you see the game?", channel: "remote", noiseLabel: "small_talk" },
    { idx: 1000, startMs: 65000, speaker: "Priya", text: "I'll send the draft by Friday.", channel: "remote", noiseLabel: null },
  ]),
}));

const SUMMARY_V2 = {
  schemaVersion: 2,
  mode: "PROJECT",
  tldr: "Budget agreed; draft due Friday.",
  keyPoints: [{ text: "Budget is 10k", evidence: [{ idx: 1000, speaker: "Priya", startMs: 65000 }], confidence: 0.9, needsReview: false }],
  decisions: [{ text: "Go with vendor A", decidedBy: "You", evidence: [{ idx: 0, speaker: "You", startMs: 0 }], confidence: 0.9, needsReview: false }],
  actionItems: [{ task: "Buy snacks", owner: "Sam" }],
  dates: [],
  openQuestions: [{ text: "Who signs off?", evidence: [], confidence: 0.8, needsReview: false }],
  whoSaidWhat: [],
  glossary: [],
  nextSessionPrep: [],
  keywords: [],
  sentiment: { overall: "POSITIVE", rationale: "" },
  sections: {},
  sinceLastTime: {
    version: 1,
    seriesId: "s1",
    generatedAt: "2026-11-15T00:00:00.000Z",
    items: [
      { actionItemId: "a-old", task: "Fix login", owner: "Sam", dueSpoken: null, fromMeeting: { id: "m0", title: "Week 1", createdAt: "2026-11-08T00:00:00.000Z" }, status: "done", note: "fixed on Monday", evidence: [], suggestedStatus: "COMPLETED", resolution: "applied" },
      { actionItemId: "a-x", task: "Dismissed thing", owner: null, dueSpoken: null, fromMeeting: { id: "m0", title: "Week 1", createdAt: "2026-11-08T00:00:00.000Z" }, status: "done", note: null, evidence: [], suggestedStatus: "COMPLETED", resolution: "dismissed" },
    ],
  },
};

const meetingRow = {
  title: "Weekly sync",
  createdAt: new Date("2026-11-14T10:00:00Z"),
  startedAt: new Date("2026-11-14T10:00:00Z"),
  durationSec: 2700,
  mode: "PROJECT",
  series: { name: "Project Phoenix" },
  summary: { data: SUMMARY_V2 },
  actionItems: [
    { task: "Send the budget draft", owner: "Priya", dueDate: "2026-11-20", dueSpoken: "by Friday", status: "PENDING", needsReview: false },
    // Rejected by a human (correction above); its row may linger in data.
    { task: "Buy snacks", owner: "Sam", dueDate: null, dueSpoken: null, status: "PENDING", needsReview: false },
  ],
  user: { email: "alice@example.com", name: "Alice", displayName: "Alice B", timezone: "Europe/London" },
};

beforeEach(() => {
  vi.mocked(exportRepo.findForExport).mockResolvedValue(meetingRow as never);
});

afterEach(() => setTransportForTests(null));


const app = createApp();

describe("export content", () => {
  it("uses names, drops noise, rejected and dismissed items, and contains no ids", async () => {
    const res = await request(app).get("/api/meetings/m-1/export?format=md&transcript=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.headers["content-disposition"]).toContain("Weekly sync 2026-11-14.md");

    const md = res.text;
    expect(md).toContain("# Weekly sync");
    expect(md).toContain("Series: Project Phoenix");
    expect(md).toContain("Send the budget draft _(owner: Priya; due: by Friday)_");
    expect(md).toContain("Go with vendor A _(by Alice B; Alice B at 0:00)_");
    expect(md).toContain("Budget is 10k _(Priya at 1:05)_");
    expect(md).toContain("**[0:00] Alice B:** Let's start");
    expect(md).toContain("Fix login _(done; owner: Sam; from \"Week 1\"; fixed on Monday)_");

    expect(md).not.toContain("Buy snacks");
    expect(md).not.toContain("Dismissed thing");
    expect(md).not.toContain("the game");
    expect(md).not.toMatch(/m-1|a-old|s1\b|idx|1000/);
  });

  it("copy as Markdown returns JSON", async () => {
    const res = await request(app).get("/api/meetings/m-1/export");
    expect(res.body.data.markdown).toContain("# Weekly sync");
    expect(res.body.data.fileName).toBe("Weekly sync 2026-11-14.md");
  });

  it("produces a PDF", async () => {
    const res = await request(app).get("/api/meetings/m-1/export?format=pdf").buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on("data", (c: Buffer) => parts.push(c));
      r.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejects an unknown format", async () => {
    expect((await request(app).get("/api/meetings/m-1/export?format=docx")).status).toBe(400);
  });

  it("escapes Markdown and survives non-Latin text in the PDF", async () => {
    const doc = buildExport({
      meeting: { title: "Q4 *plan* [draft] – 東京", createdAt: new Date(), startedAt: null, durationSec: null, mode: "AUTO", seriesName: null },
      summaryData: { executiveSummary: "Legacy summary", keyDecisions: ["Ship it"] },
      actionItems: [],
      rejectedTasks: [],
      segments: [],
      meLabel: "You",
      defaultMeLabel: "You",
      timezone: null,
      includeTranscript: false,
    } satisfies ExportInput);
    expect(toMarkdown(doc)).toContain("# Q4 \\*plan\\* \\[draft\\]");
    expect(toMarkdown(doc)).toContain("- Ship it");
    expect(toLatin1("– 東京")).toBe("- ??");
    expect((await toPdf(doc)).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("email", () => {
  it("answers 503 when SMTP is not configured", async () => {
    const res = await request(app).post("/api/meetings/m-1/export/email").send({});
    expect(res.status).toBe(503);
  });

  it("sends Markdown + PDF to the owner by default (mock transport only)", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = vi.spyOn(transport, "sendMail");
    setTransportForTests(transport);

    const res = await request(app).post("/api/meetings/m-1/export/email").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.recipients).toEqual(["alice@example.com"]);

    const message = sendMail.mock.calls[0][0];
    expect(message.to).toEqual(["alice@example.com"]);
    expect(message.subject).toBe("Meeting notes: Weekly sync");
    expect(String(message.text)).toContain("Send the budget draft");
    expect((message.attachments as { filename: string }[]).map((a) => a.filename)).toEqual([
      "Weekly sync 2026-11-14.pdf",
      "Weekly sync 2026-11-14.md",
    ]);
  });

  it("validates recipients", async () => {
    setTransportForTests(nodemailer.createTransport({ jsonTransport: true }));
    const bad = await request(app).post("/api/meetings/m-1/export/email").send({ to: "not-an-email" });
    expect(bad.status).toBe(400);
    const many = await request(app)
      .post("/api/meetings/m-1/export/email")
      .send({ to: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`) });
    expect(many.status).toBe(400);
    const two = await request(app).post("/api/meetings/m-1/export/email").send({ to: "a@example.com, B@example.com" });
    expect(two.body.data.recipients).toEqual(["a@example.com", "b@example.com"]);
  });
});
