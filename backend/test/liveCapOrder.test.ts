import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import * as accessRepo from "../src/repositories/access.repository";
import { AppError } from "../src/types/errors";

/**
 * MAX_AUDIO_MINUTES on live chunks must run after device auth and the
 * session owner check, so a capped session never turns a 401 or a 404
 * into a 413. The cap is off in tests, so it is replaced here by one
 * that always refuses.
 */
vi.mock("../src/middleware/rateLimit.middleware", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  durationCaps: {
    live: (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
      next(new AppError("This capture is longer than this server's limit.", 413)),
    recording: (_req: unknown, _res: unknown, next: () => void) => next(),
    singleRequestUpload: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));

const app = createApp();

describe("live chunk cap runs after auth", () => {
  it("is a 401 without a session or token", async () => {
    const res = await request(app)
      .post("/api/live/sessions/s1/chunks")
      .set("x-test-user", "anonymous");
    expect(res.status).toBe(401);
  });

  it("is a 404 for another account's session", async () => {
    vi.mocked(accessRepo.liveSessionOwnerId).mockResolvedValueOnce("someone-else");
    const res = await request(app).post("/api/live/sessions/s1/chunks");
    expect(res.status).toBe(404);
  });

  it("still applies the cap to the owner", async () => {
    const res = await request(app).post("/api/live/sessions/s1/chunks");
    expect(res.status).toBe(413);
  });
});
