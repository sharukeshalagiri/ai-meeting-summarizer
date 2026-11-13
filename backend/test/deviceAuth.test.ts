import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDeviceAuth } from "../src/middleware/deviceAuth.middleware";
import { errorHandler } from "../src/middleware/error.middleware";

const appWith = (token: string | null) => {
  const app = express();
  app.use(createDeviceAuth(token));
  app.get("/x", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
};

describe("device auth middleware", () => {
  const app = appWith("s3cret-token");

  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/x");
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/missing device token/i);
  });

  it("rejects a wrong token, including one of a different length", async () => {
    for (const token of ["wrong-token-1", "s3cret-tokeN", "s"]) {
      const res = await request(app)
        .get("/x")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  it("rejects a non-Bearer scheme", async () => {
    const res = await request(app)
      .get("/x")
      .set("Authorization", "Basic s3cret-token");
    expect(res.status).toBe(401);
  });

  it("accepts the right token", async () => {
    const res = await request(app)
      .get("/x")
      .set("Authorization", "Bearer s3cret-token");
    expect(res.status).toBe(200);
  });

  it("lets requests through when no token is configured (development)", async () => {
    const res = await request(appWith(null)).get("/x");
    expect(res.status).toBe(200);
  });
});

describe("DEVICE_TOKEN configuration", () => {
  it("refuses to load in production without DEVICE_TOKEN", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEVICE_TOKEN", "");

    await expect(import("../src/lib/env")).rejects.toThrow(/DEVICE_TOKEN/);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("protects the real /api/live routes when DEVICE_TOKEN is set", async () => {
    vi.resetModules();
    vi.stubEnv("DEVICE_TOKEN", "route-token");

    const { createApp } = await import("../src/app");
    const app = createApp();

    const denied = await request(app)
      .post("/api/live/sessions/any/end")
      .send({});
    expect(denied.status).toBe(401);

    // Other API routes are unaffected.
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
