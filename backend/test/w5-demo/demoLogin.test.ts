import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import * as demoRepo from "../../src/demo/demo.repository";

/**
 * "Try the demo" end to end with a real session cookie: passport,
 * express-session and the Prisma session store (its repository replaced
 * by an in-memory table), as in test/w4-acct/auth.test.ts. DEMO_MODE is
 * switched on in vi.hoisted, which runs before the imports load env.
 */

const { sessions, users } = vi.hoisted(() => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_SESSION_HOURS = "2";
  return {
    sessions: new Map<string, { data: { cookie?: { originalMaxAge?: number } }; expiresAt: Date; userId: string | null }>(),
    users: new Map([["demo-id", { id: "demo-id", name: "Demo visitor", email: "demo@example.com" }]]),
  };
});

vi.unmock("../../src/lib/auth/currentUser");

vi.mock("../../src/repositories/user.repository", () => ({
  findById: async (id: string) =>
    users.has(id)
      ? {
          ...users.get(id)!,
          createdAt: new Date(0),
          displayName: null,
          timezone: null,
          defaultMode: "AUTO",
          transcriptionProvider: null,
          glossary: [],
          audioRetention: "KEEP",
          audioRetentionDays: null,
        }
      : null,
}));

vi.mock("../../src/repositories/session.repository", () => ({
  find: async (sid: string) => (sessions.has(sid) ? { sid, ...sessions.get(sid)! } : null),
  upsert: async (sid: string, data: never, expiresAt: Date, userId: string | null) => {
    sessions.set(sid, { data, expiresAt, userId });
    return {};
  },
  touch: async (sid: string, expiresAt: Date) => {
    const row = sessions.get(sid);
    if (row) row.expiresAt = expiresAt;
    return { count: row ? 1 : 0 };
  },
  destroy: async (sid: string) => ({ count: sessions.delete(sid) ? 1 : 0 }),
  destroyForUser: async () => ({ count: 0 }),
  deleteExpired: async () => ({ count: 0 }),
}));

vi.mock("../../src/demo/demo.repository", () => ({
  findDemoUser: vi.fn(async () => users.get("demo-id") ?? null),
  firstMeetingId: vi.fn(async () => "lecture-meeting"),
  findSegmentsContaining: vi.fn(async () => []),
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  findAll: vi.fn(async () => []),
  create: vi.fn(async () => {
    throw new Error("must not be reached");
  }),
}));

const app = createApp();

const cookieOf = (res: request.Response) =>
  (res.headers["set-cookie"] as unknown as string[] | undefined)?.find((c) => c.startsWith("ams.sid="))?.split(";")[0] ?? null;

describe("Try the demo", () => {
  it("says the demo is on", async () => {
    const res = await request(app).get("/api/demo");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: true, readOnly: true });
  });

  it("signs in without a password, for DEMO_SESSION_HOURS, and lands on a meeting", async () => {
    const login = await request(app).post("/api/demo/login");
    expect(login.status).toBe(200);
    expect(login.body.data).toEqual({
      user: { id: "demo-id", name: "Demo visitor", email: "demo@example.com" },
      meetingId: "lecture-meeting",
    });

    const cookie = cookieOf(login);
    expect(cookie).not.toBeNull();
    const expires = /Expires=([^;]+)/i.exec((login.headers["set-cookie"] as unknown as string[]).join(";"))?.[1];
    expect(Math.abs(Date.parse(expires!) - Date.now() - 2 * 3600_000)).toBeLessThan(60_000);

    // The stored session keeps the short max age, so the rolling cookie stays short.
    const stored = [...sessions.values()].find((row) => row.userId === "demo-id");
    expect(stored?.data.cookie?.originalMaxAge).toBe(2 * 3600 * 1000);

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie!);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe("demo@example.com");

    expect((await request(app).get("/api/meetings").set("Cookie", cookie!)).status).toBe(200);

    const write = await request(app).post("/api/meetings").set("Cookie", cookie!).send({ title: "mine now" });
    expect(write.status).toBe(403);
  });

  it("is a 503 with a hint when the demo was never seeded", async () => {
    vi.mocked(demoRepo.findDemoUser).mockResolvedValueOnce(null);
    const res = await request(app).post("/api/demo/login");
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/demo:seed/);
  });
});
