import request from "supertest";
import { describe, expect, it, vi } from "vitest";

/**
 * The pg-boss driver when the queue cannot start (database down): the
 * boot fails and is logged, the HTTP app stays up, /api/health reports
 * queue "down", readiness answers 503, and every route that would queue
 * work answers 503 with a user-safe message (never the driver's error).
 */

const UPSTREAM_SECRET = "connect ECONNREFUSED 10.0.0.5:5432 password=hunter2";

const calls = vi.hoisted(() => ({ started: 0, stopped: 0, progressWrites: 0 }));


// Read-time speaker names (speakers.service) look up profiles and
// corrections; none here, so responses pass through unchanged.
vi.mock("../../src/repositories/speakerProfile.repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findByMeetingId: async () => [],
}));
vi.mock("../../src/repositories/correction.repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findByMeetingId: async () => [],
}));

vi.mock("../../src/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/env")>();
  return { env: { ...actual.env, jobsDriver: "pgboss" } };
});

vi.mock("../../src/jobs/pgBossQueue", () => ({
  PgBossQueue: class {
    readonly driver = "pgboss";
    async start() {
      calls.started += 1;
      throw new Error(UPSTREAM_SECRET);
    }
    async stop() {
      calls.stopped += 1;
    }
  },
}));

const meeting = {
  id: "m1",
  status: "TRANSCRIBED",
  source: "UPLOAD",
  audioPath: "uploads/meetings/m1.wav",
  processingStage: null,
  processingProgress: null,
  processingError: null,
  summary: null,
};

vi.mock("../../src/repositories/meeting.repository", () => ({
  findById: async (id: string) => (id === "m1" ? { ...meeting } : null),
  exists: async (id: string) => id === "m1",
  findProgress: async (id: string) => (id === "m1" ? { ...meeting } : null),
  updateProcessing: async () => {
    calls.progressWrites += 1;
  },
}));

vi.mock("../../src/repositories/transcript.repository", () => ({
  findByMeetingId: async () => ({ id: "t1", meetingId: "m1" }),
}));

import { createApp } from "../../src/app";
import { JOBS_UNAVAILABLE, queueStatus, startJobs } from "../../src/jobs/index";

const app = createApp();

describe("job queue down (pg-boss failed to start)", () => {
  it("fails the boot without leaking the half-started driver", async () => {
    await expect(startJobs()).rejects.toThrow(UPSTREAM_SECRET);
    expect(calls.started).toBe(1);
    expect(calls.stopped).toBe(1);
    expect(queueStatus()).toBe("down");

    // A later boot attempt (server.ts retries) tries again from scratch.
    await expect(startJobs()).rejects.toThrow();
    expect(calls.started).toBe(2);
  });

  it("/api/health stays 200 and reports queue down; readiness is 503", async () => {
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.data).toMatchObject({ queue: "down", status: "degraded", jobsDriver: "pgboss" });

    const ready = await request(app).get("/api/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ success: false, message: JOBS_UNAVAILABLE });

    // The root liveness probe is untouched.
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it.each([
    ["post", "/api/meetings/m1/process"],
    ["post", "/api/meetings/m1/retry"],
    ["get", "/api/meetings/m1/events"],
    ["post", "/api/meetings/m1/summarize"],
    ["post", "/api/meetings/m1/resummarize"],
  ] as const)("%s %s answers 503 with a safe message", async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, message: JOBS_UNAVAILABLE });
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });

  it("writes no processing stage that no job would ever move", () => {
    expect(calls.progressWrites).toBe(0);
  });

  it("reads that need no queue still work", async () => {
    const res = await request(app).get("/api/meetings/m1");
    expect(res.status).toBe(200);
  });
});
