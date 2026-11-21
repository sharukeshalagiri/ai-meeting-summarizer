import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  clientKey,
  createDurationCaps,
  createRateLimit,
  FixedWindowCounter,
  isHeavy,
} from "../../src/middleware/rateLimit.middleware";
import { errorHandler } from "../../src/middleware/error.middleware";

/** Rate limits and duration caps, on small apps with a fake clock. */

const appWith = (...handlers: express.RequestHandler[]) => {
  const app = express();
  app.use(...handlers);
  app.all("/{*rest}", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
};

describe("FixedWindowCounter", () => {
  it("allows the limit, then says how long to wait, then resets", () => {
    const counter = new FixedWindowCounter(2, 60_000);
    expect(counter.take("a", 0).allowed).toBe(true);
    expect(counter.take("a", 1000).allowed).toBe(true);
    expect(counter.take("a", 2000)).toEqual({ allowed: false, retryAfterSec: 58 });
    expect(counter.take("b", 2000).allowed).toBe(true);
    expect(counter.take("a", 60_000).allowed).toBe(true);
  });
});

describe("rate limit middleware", () => {
  it("answers 429 with Retry-After past the per-minute limit", async () => {
    let now = 0;
    const app = appWith(createRateLimit({ enabled: true, perMinute: 3, heavyPerHour: 100, now: () => now }));

    for (let i = 0; i < 3; i++) expect((await request(app).get("/meetings")).status).toBe(200);
    const limited = await request(app).get("/meetings");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.body.success).toBe(false);

    now = 61_000;
    expect((await request(app).get("/meetings")).status).toBe(200);
  });

  it("gives expensive requests a smaller hourly budget", async () => {
    const app = appWith(createRateLimit({ enabled: true, perMinute: 100, heavyPerHour: 2, now: () => 0 }));

    expect((await request(app).post("/meetings/m1/process")).status).toBe(200);
    expect((await request(app).post("/chat")).status).toBe(200);
    expect((await request(app).post("/demo/login")).status).toBe(429);
    // Cheap requests are still fine.
    expect((await request(app).get("/meetings/m1")).status).toBe(200);
  });

  it("does nothing when disabled (the default outside production)", async () => {
    const app = appWith(createRateLimit({ enabled: false, perMinute: 1, heavyPerHour: 1 }));
    for (let i = 0; i < 5; i++) expect((await request(app).post("/chat")).status).toBe(200);
  });

  it("classifies heavy routes", () => {
    expect(isHeavy("POST", "/meetings/abc/audio")).toBe(true);
    expect(isHeavy("POST", "/meetings/abc/export/email")).toBe(true);
    expect(isHeavy("POST", "/live/sessions")).toBe(true);
    expect(isHeavy("POST", "/live/sessions/s1/chunks")).toBe(false);
    expect(isHeavy("GET", "/meetings/abc/audio")).toBe(false);
  });
});

describe("clientKey", () => {
  const req = (peer: string, forwarded?: string, user?: { id: string }) =>
    ({
      socket: { remoteAddress: peer },
      user,
      // x-test-user: the test setup's identity seam (anonymous unless a user is given).
      header: (name: string) =>
        name.toLowerCase() === "x-forwarded-for" ? forwarded : name === "x-test-user" && !user ? "anonymous" : undefined,
    }) as never;

  it("keys by user when signed in", () => {
    expect(clientKey(req("1.2.3.4", undefined, { id: "u1" }))).toBe("user:u1");
  });

  it("trusts the proxy's X-Forwarded-For entry only behind a private peer", () => {
    expect(clientKey(req("172.18.0.5", "6.6.6.6, 9.9.9.9"))).toBe("ip:9.9.9.9");
    expect(clientKey(req("::ffff:127.0.0.1", "9.9.9.9"))).toBe("ip:9.9.9.9");
    expect(clientKey(req("8.8.8.8", "1.1.1.1"))).toBe("ip:8.8.8.8");
  });
});

describe("duration caps (MAX_AUDIO_MINUTES)", () => {
  const capped = (options: Parameters<typeof createDurationCaps>[0]) => {
    const caps = createDurationCaps(options);
    const app = express();
    app.post("/meetings/:id/process", caps.recording);
    app.post("/meetings/:id/upload", caps.singleRequestUpload);
    app.post("/live/sessions/:id/chunks", caps.live);
    app.all("/{*rest}", (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  };

  it("refuses a recording longer than the cap, before any work", async () => {
    const probe = vi.fn(async () => 61 * 60);
    const app = capped({ maxMinutes: 60, probe, audioPathOf: async () => "uploads/meetings/long.ogg" });

    const res = await request(app).post("/meetings/m1/process");
    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/60-minute limit/);
    expect(probe).toHaveBeenCalledWith(expect.stringMatching(/long\.ogg$/));
  });

  it("lets a recording within the cap through, and fails open when it cannot measure", async () => {
    const ok = capped({ maxMinutes: 60, probe: async () => 59 * 60, audioPathOf: async () => "a.ogg" });
    expect((await request(ok).post("/meetings/m1/process")).status).toBe(200);

    const unknown = capped({
      maxMinutes: 60,
      probe: async () => {
        throw new Error("ffprobe not found");
      },
      audioPathOf: async () => "a.ogg",
    });
    expect((await request(unknown).post("/meetings/m1/process")).status).toBe(200);
  });

  it("stops a live capture at the cap", async () => {
    const app = capped({ maxMinutes: 30, elapsedMsOf: async (id) => (id === "long" ? 30 * 60_000 : 1000) });
    expect((await request(app).post("/live/sessions/long/chunks")).status).toBe(413);
    expect((await request(app).post("/live/sessions/short/chunks")).status).toBe(200);
  });

  it("sends single-request uploads to the staged flow while capped", async () => {
    expect((await request(capped({ maxMinutes: 30 })).post("/meetings/m1/upload")).status).toBe(400);
  });

  it("is off at 0 (the default outside production)", async () => {
    const lookup = vi.fn(async () => "a.ogg");
    const app = capped({ maxMinutes: 0, audioPathOf: lookup, elapsedMsOf: async () => 10 ** 9 });
    expect((await request(app).post("/meetings/m1/process")).status).toBe(200);
    expect((await request(app).post("/meetings/m1/upload")).status).toBe(200);
    expect((await request(app).post("/live/sessions/s/chunks")).status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });
});
