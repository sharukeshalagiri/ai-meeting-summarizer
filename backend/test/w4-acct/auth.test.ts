import request from "supertest";
import { createApp } from "../../src/app";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../../src/lib/auth/password";

/**
 * Sign-in end to end: passport's local strategy, express-session with
 * the Prisma store (its repository replaced by an in-memory table) and
 * real argon2 hashes. The global test identity (setup.auth.ts) is
 * turned off here, so only a real session cookie signs a request in.
 */

vi.unmock("../../src/lib/auth/currentUser");

type User = { id: string; name: string; email: string; passwordHash: string | null };
const users = new Map<string, User>();
const sessions = new Map<string, { data: unknown; expiresAt: Date; userId: string | null }>();

const view = (u: User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  createdAt: new Date(0),
  displayName: null,
  timezone: null,
  defaultMode: "AUTO",
  transcriptionProvider: null,
  glossary: [],
  audioRetention: "KEEP",
  audioRetentionDays: null,
});
const byEmail = (email: string) => [...users.values()].find((u) => u.email === email);

vi.mock("../../src/repositories/user.repository", () => ({
  findById: async (id: string) => (users.has(id) ? view(users.get(id)!) : null),
  findByEmail: async (email: string) => (byEmail(email) ? view(byEmail(email)!) : null),
  findCredentialsByEmail: async (email: string) => byEmail(email) ?? null,
  findPasswordHash: async (id: string) => users.get(id)?.passwordHash ?? null,
  setPasswordHash: async (id: string, passwordHash: string) => {
    users.get(id)!.passwordHash = passwordHash;
    return { id };
  },
  create: async (data: { name: string; email: string; passwordHash?: string | null }) => {
    const user = { id: `u${users.size + 1}`, passwordHash: null, ...data };
    users.set(user.id, user);
    return view(user);
  },
}));

vi.mock("../../src/repositories/session.repository", () => ({
  find: async (sid: string) => (sessions.has(sid) ? { sid, ...sessions.get(sid)! } : null),
  upsert: async (sid: string, data: unknown, expiresAt: Date, userId: string | null) => {
    sessions.set(sid, { data, expiresAt, userId });
    return {};
  },
  touch: async (sid: string, expiresAt: Date) => {
    const row = sessions.get(sid);
    if (row) row.expiresAt = expiresAt;
    return { count: row ? 1 : 0 };
  },
  destroy: async (sid: string) => ({ count: sessions.delete(sid) ? 1 : 0 }),
  destroyForUser: async (userId: string, exceptSid?: string) => {
    let count = 0;
    for (const [sid, row] of sessions) {
      if (row.userId === userId && sid !== exceptSid) {
        sessions.delete(sid);
        count++;
      }
    }
    return { count };
  },
  deleteExpired: async () => ({ count: 0 }),
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  findAll: vi.fn(async () => []),
}));


const app = createApp();

const PASSWORD = "correct horse battery";

beforeAll(async () => {
  users.set("u-dev", { id: "u-dev", name: "Dev", email: "dev@example.com", passwordHash: await hashPassword(PASSWORD) });
});

const cookieOf = (res: request.Response) => {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  return header?.find((c) => c.startsWith("ams.sid="))?.split(";")[0] ?? null;
};

const login = (email: string, password: string) =>
  request(app).post("/api/auth/login").send({ email, password });

describe("sign in", () => {
  it("rejects a wrong password and an unknown email with the same 401", async () => {
    const wrong = await login("dev@example.com", "not the password");
    const unknown = await login("nobody@example.com", PASSWORD);

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
    expect(cookieOf(wrong)).toBeNull();
  });

  it("sets an httpOnly, SameSite=Lax session cookie and signs the user in", async () => {
    const res = await login("DEV@example.com ", PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: "u-dev", name: "Dev", email: "dev@example.com" });

    const raw = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ams.sid="))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);

    const cookie = cookieOf(res)!;
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe("dev@example.com");
    expect(JSON.stringify(me.body)).not.toContain("passwordHash");

    const meetings = await request(app).get("/api/meetings").set("Cookie", cookie);
    expect(meetings.status).toBe(200);
  });

  it("protects the API without a session", async () => {
    expect((await request(app).get("/api/meetings")).status).toBe(401);
    const me = await request(app).get("/api/auth/me");
    expect(me.status).toBe(401);
    expect(me.body.data).toEqual({ signupEnabled: true });
  });

  it("signs out: the old cookie no longer works", async () => {
    const cookie = cookieOf(await login("dev@example.com", PASSWORD))!;
    const out = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(200);

    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });
});

describe("sign up and password change", () => {
  it("creates an account and signs it in; duplicates and weak passwords are refused", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ name: "New", email: "new@example.com", password: "long enough password" });
    expect(res.status).toBe(201);
    expect(cookieOf(res)).not.toBeNull();
    expect(users.get(res.body.data.id)!.passwordHash).toMatch(/^\$argon2id\$/);

    const again = await request(app)
      .post("/api/auth/signup")
      .send({ name: "New", email: "NEW@example.com", password: "long enough password" });
    expect(again.status).toBe(409);

    const weak = await request(app).post("/api/auth/signup").send({ name: "W", email: "w@example.com", password: "short" });
    expect(weak.status).toBe(400);
  });

  it("changing the password signs out every other session", async () => {
    const first = cookieOf(await login("dev@example.com", PASSWORD))!;
    const second = cookieOf(await login("dev@example.com", PASSWORD))!;

    const res = await request(app)
      .post("/api/auth/password")
      .set("Cookie", first)
      .send({ currentPassword: PASSWORD, newPassword: "a brand new passphrase" });
    expect(res.status).toBe(200);

    expect((await request(app).get("/api/auth/me").set("Cookie", first)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", second)).status).toBe(401);
    expect((await login("dev@example.com", PASSWORD)).status).toBe(401);
    expect((await login("dev@example.com", "a brand new passphrase")).status).toBe(200);
  });
});

describe("throttle", () => {
  it("answers 429 after repeated failures for an email", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login("victim@example.com", `guess ${i}`)).status;
    expect(last).toBe(429);
  });
});
