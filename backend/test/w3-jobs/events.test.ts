import type { AddressInfo } from "net";
import type { Server } from "http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/meetings/:id/events (SSE) and the 202 process/retry routes,
 * through the real app with the meeting repository in memory.
 */

const store = vi.hoisted(() => ({
  row: null as null | {
    id: string;
    status: string;
    source: string;
    processingStage: string | null;
    processingProgress: number | null;
    processingError: string | null;
  },
  retried: [] as string[],
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  findProgress: async (id: string) => (store.row?.id === id ? { ...store.row } : null),
}));

vi.mock("../../src/services/meeting.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/meeting.service")>();
  return {
    ...actual,
    retryProcessing: async (meetingId: string) => {
      store.retried.push(meetingId);
      return { meetingId, status: "PROCESSING", processingStage: "CLEANING" };
    },
    startProcessing: async (meetingId: string) => ({
      meetingId,
      status: "PROCESSING",
      processingStage: "TRANSCRIBING",
    }),
  };
});

import { createApp } from "../../src/app";
import { emitProgress } from "../../src/jobs/progress";

const app = createApp();
let server: Server;
let base: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  store.row = {
    id: "m1",
    status: "PROCESSING",
    source: "UPLOAD",
    processingStage: "SUMMARIZING",
    processingProgress: 0,
    processingError: null,
  };
  store.retried = [];
});

/** Reads SSE events from a fetch body until `count` arrive or the stream ends. */
const readEvents = async (body: ReadableStream<Uint8Array>, until: (events: { event: string; data: unknown }[]) => boolean) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = "";
  let raw = "";

  while (!until(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    buffer += text;

    let split: number;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event) events.push({ event, data: data ? JSON.parse(data) : null });
    }
  }

  return { events, raw, reader };
};

describe("GET /api/meetings/:id/events", () => {
  it("sends the state at once, then each change, then ends when settled", async () => {
    const res = await fetch(`${base}/api/meetings/m1/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);

    const first = await readEvents(res.body!, (events) => events.length >= 1);
    expect(first.raw).toMatch(/^retry: 3000\n\n/);
    expect(first.events[0]).toEqual({
      event: "progress",
      data: expect.objectContaining({ processingStage: "SUMMARIZING", status: "PROCESSING" }),
    });
    first.reader.releaseLock();

    // A job writes progress: pushed without waiting for the poll.
    store.row!.processingProgress = 50;
    store.row!.processingError = "The detailed summary could not be generated, so a basic summary was used instead.";
    emitProgress("m1", { progress: 50 });

    const second = await readEvents(res.body!, (events) => events.length >= 1);
    expect(second.events[0].data).toMatchObject({ processingProgress: 50 });
    second.reader.releaseLock();

    store.row!.processingStage = "DONE";
    store.row!.status = "COMPLETED";
    emitProgress("m1", { stage: "DONE" });

    const last = await readEvents(res.body!, () => false);
    expect(last.events.map((e) => e.event)).toEqual(["progress", "end"]);
    expect(last.events[0].data).toMatchObject({ processingStage: "DONE", status: "COMPLETED" });
  });

  it("ends at once for a meeting with nothing running (no reconnect loop)", async () => {
    store.row!.processingStage = "FAILED";
    store.row!.status = "FAILED";
    store.row!.processingError = "[SUMMARIZING/RATE_LIMITED] The AI service is rate limited or out of quota. Retry later from this page.";

    const res = await fetch(`${base}/api/meetings/m1/events`);
    const { events } = await readEvents(res.body!, () => false);

    expect(events.map((e) => e.event)).toEqual(["progress", "end"]);
    expect(events[0].data).toMatchObject({ processingStage: "FAILED" });
  });

  it("404s as JSON for an unknown meeting", async () => {
    const res = await request(app).get("/api/meetings/nope/events");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /api/meetings/:id/process and /retry", () => {
  it("answer 202 with the queued stage", async () => {
    const retry = await request(app).post("/api/meetings/m1/retry");
    expect(retry.status).toBe(202);
    expect(retry.body.data).toEqual({ meetingId: "m1", status: "PROCESSING", processingStage: "CLEANING" });
    expect(store.retried).toEqual(["m1"]);

    const process = await request(app).post("/api/meetings/m1/process");
    expect(process.status).toBe(202);
    expect(process.body.data.processingStage).toBe("TRANSCRIBING");
  });
});
