import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../src/lib/auth/currentUser";
import { createDeviceAuth } from "../src/middleware/deviceAuth.middleware";
import { errorHandler } from "../src/middleware/error.middleware";

/**
 * Device auth with per-user tokens (w4-acct). The shared DEVICE_TOKEN
 * is gone: a Bearer token must be a live token of some account, and the
 * request then runs as that account. Without a header the session is
 * used (test/setup.auth.ts signs requests in unless x-test-user is
 * "anonymous"). The real routes, revocation and both recorders' upload
 * paths are covered in test/w4-acct/devices.test.ts.
 */

// The real-route test below looks tokens up here; no database.

// Read-time speaker names (speakers.service) look up profiles and
// corrections; none here, so responses pass through unchanged.
vi.mock("../src/repositories/speakerProfile.repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findByMeetingId: async () => [],
}));
vi.mock("../src/repositories/correction.repository", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findByMeetingId: async () => [],
}));

vi.mock("../src/repositories/deviceToken.repository", () => ({
  findByHash: vi.fn(async () => null),
  markUsed: vi.fn(async () => ({ id: "x" })),
}));

const ALICE: AuthUser = { id: "alice", name: "Alice", email: "alice@example.com", deviceTokenId: "d1" };

const appWith = (tokens: Record<string, AuthUser>) => {
  const authenticate = vi.fn(async (token: string) => tokens[token] ?? null);
  const app = express();
  app.use(createDeviceAuth(authenticate));
  app.get("/x", (req, res) => {
    res.json({ user: req.user ?? null });
  });
  app.use(errorHandler);
  return { app, authenticate };
};

describe("device auth middleware", () => {
  const { app, authenticate } = appWith({ "amsd_alice-token": ALICE });

  it("accepts a live token and runs the request as its account", async () => {
    const res = await request(app).get("/x").set("Authorization", "Bearer amsd_alice-token");
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe("alice");
    expect(authenticate).toHaveBeenCalledWith("amsd_alice-token");
  });

  it("rejects an unknown or revoked token", async () => {
    for (const token of ["wrong-token", "amsd_alice-tokeN", "s"]) {
      const res = await request(app).get("/x").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid or revoked/i);
    }
  });

  it("rejects a non-Bearer scheme", async () => {
    const res = await request(app).get("/x").set("Authorization", "Basic amsd_alice-token");
    expect(res.status).toBe(401);
  });

  it("never falls back to the session when a token is present but bad", async () => {
    // The default test session is signed in; the bad token still wins.
    const res = await request(app).get("/x").set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("uses the session when no token is sent (the web Live page)", async () => {
    const res = await request(app).get("/x");
    expect(res.status).toBe(200);
  });

  it("rejects a request with neither token nor session", async () => {
    const res = await request(app).get("/x").set("x-test-user", "anonymous");
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/missing device token/i);
  });
});

describe("configuration", () => {
  it("boots in production without the old shared DEVICE_TOKEN", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEVICE_TOKEN", "");
    vi.stubEnv("SESSION_SECRET", "x".repeat(40));

    const { env } = await import("../src/lib/env");
    expect(env.deviceToken).toBeNull();
    expect(env.authAllowSignup).toBe(false);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to load in production without SESSION_SECRET", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");

    await expect(import("../src/lib/env")).rejects.toThrow(/SESSION_SECRET/);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("protects the real /api/live routes", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp();

    const denied = await request(app)
      .post("/api/live/sessions/any/end")
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(denied.status).toBe(401);

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
  });
});
