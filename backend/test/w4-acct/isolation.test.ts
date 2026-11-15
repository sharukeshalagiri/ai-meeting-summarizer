import type { Router } from "express";
import request from "supertest";
import { createApp } from "../../src/app";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two accounts cannot see each other's data, on every route.
 *
 * Alice ("alice") and Bob ("bob") each own rows whose ids start with
 * their initial: meeting "B-meeting", live session "B-session", ... The
 * ownership lookups (access.repository) answer accordingly. Then:
 *
 * 1. Every route with an id, called by Alice with Bob's id, is a 404
 *    (exactly like a missing row), and the controller never runs.
 * 2. Every list/create route, called by Alice, reaches the repositories
 *    with Alice's id only.
 * 3. Every non-public route without a session is a 401.
 *
 * A route registered anywhere that this file does not classify fails
 * the "every route is covered" test, so a new endpoint cannot ship
 * without an isolation check.
 */

// vi.hoisted: the vi.mock factories below run before the imports.
const { ALICE, BOB, ownerOf, seen, rec } = vi.hoisted(() => {
  const ALICE = "alice";
  const BOB = "bob";

  const ownerOf = async (id: string) =>
    id.startsWith("A-") ? ALICE : id.startsWith("B-") ? BOB : null;

  // Every repository a list or create route can reach. Each records the
  // user id it was asked for, so the test can prove it was Alice's.
  const seen: { fn: string; userId: unknown }[] = [];
  const rec =
    <T>(fn: string, result: T, userArg = 0) =>
    (...args: unknown[]) => {
      const arg = args[userArg];
      seen.push({
        fn,
        userId: typeof arg === "object" && arg !== null && "userId" in arg ? (arg as { userId: unknown }).userId : arg,
      });
      return Promise.resolve(result);
    };

  return { ALICE, BOB, ownerOf, seen, rec };
});

vi.mock("../../src/repositories/access.repository", () => ({
  meetingOwnerId: vi.fn(ownerOf),
  liveSessionOwnerId: vi.fn(ownerOf),
  actionItemOwnerId: vi.fn(ownerOf),
  seriesOwnerId: vi.fn(ownerOf),
  conversationOwnerId: vi.fn(ownerOf),
}));

vi.mock("../../src/repositories/meeting.repository", () => ({
  findAll: vi.fn(rec("meeting.findAll", [])),
  stats: vi.fn(rec("meeting.stats", { _count: { _all: 0 }, _sum: { durationSec: 0 }, _avg: { durationSec: 0 } })),
  countByStatus: vi.fn(rec("meeting.countByStatus", [])),
  countBySource: vi.fn(rec("meeting.countBySource", [])),
  findSince: vi.fn(rec("meeting.findSince", [])),
  findSummaryData: vi.fn(rec("meeting.findSummaryData", [])),
  create: vi.fn(rec("meeting.create", { id: "A-new", source: "UPLOAD" })),
  markStarted: vi.fn(async (id: string) => ({ id, status: "LIVE" })),
}));
vi.mock("../../src/repositories/actionItem.repository", () => ({
  findAll: vi.fn(rec("actionItem.findAll", [])),
  countByStatus: vi.fn(rec("actionItem.countByStatus", [])),
  countAll: vi.fn(rec("actionItem.countAll", 0)),
  countOpenByOwner: vi.fn(rec("actionItem.countOpenByOwner", [])),
}));
vi.mock("../../src/repositories/transcript.repository", () => ({
  findAll: vi.fn(rec("transcript.findAll", [])),
}));
vi.mock("../../src/repositories/user.repository", () => ({
  findById: vi.fn(async (id: string) => ({
    id,
    name: id,
    email: `${id}@example.com`,
    createdAt: new Date(),
    displayName: null,
    timezone: null,
    defaultMode: "AUTO",
    transcriptionProvider: null,
    glossary: [],
    audioRetention: "KEEP",
    audioRetentionDays: null,
  })),
  updateSettings: vi.fn(rec("user.updateSettings", {})),
}));
vi.mock("../../src/repositories/series.repository", () => ({
  findByUser: vi.fn(rec("series.findByUser", [])),
  findOwned: vi.fn(rec("series.findOwned", null, 1)),
  findByName: vi.fn(rec("series.findByName", null)),
  create: vi.fn(rec("series.create", { id: "A-series", name: "x" })),
  rename: vi.fn(rec("series.rename", { count: 0 }, 1)),
}));
vi.mock("../../src/repositories/deviceToken.repository", () => ({
  findByUser: vi.fn(rec("device.findByUser", [])),
  findOwned: vi.fn(rec("device.findOwned", null, 1)),
  create: vi.fn(rec("device.create", { id: "A-device" })),
  findByHash: vi.fn(async () => null),
}));
vi.mock("../../src/repositories/chat.repository", () => ({
  create: vi.fn(rec("chat.create", {})),
  findByConversation: vi.fn(rec("chat.findByConversation", [], 1)),
}));
vi.mock("../../src/repositories/embedding.repository", () => ({
  search: vi.fn(rec("embedding.search", [])),
}));
vi.mock("../../src/repositories/liveSession.repository", () => ({
  create: vi.fn(async () => ({ id: "A-session" })),
}));
vi.mock("../../src/services/embedding.service", () => ({
  embedQuery: vi.fn(async () => [1, 0, 0]),
  indexMeeting: vi.fn(async () => 0),
}));


const app = createApp();

type Kind =
  | { kind: "public" }
  | { kind: "foreign"; path: string; body?: object }
  | { kind: "scoped"; path?: string; body?: object; repos: string[] }
  | { kind: "gone" };

/**
 * Every route, by "METHOD /full/path" as registered. Foreign = called
 * with Bob's ids; scoped = list/create, checked for Alice's id.
 */
const M = "/api/meetings/B-meeting";
const ROUTES: Record<string, Kind> = {
  "POST /api/auth/login": { kind: "public" },
  "POST /api/auth/logout": { kind: "public" },
  "GET /api/auth/me": { kind: "public" },
  "POST /api/auth/signup": { kind: "public" },
  "POST /api/auth/password": { kind: "public" },
  "GET /api/health/": { kind: "public" },
  "GET /api/health/ready": { kind: "public" },

  "POST /api/live/sessions": { kind: "scoped", body: { title: "t" }, repos: ["meeting.create"] },
  "POST /api/live/sessions/:id/chunks": { kind: "foreign", path: "/api/live/sessions/B-session/chunks" },
  "POST /api/live/sessions/:id/roster": { kind: "foreign", path: "/api/live/sessions/B-session/roster" },
  "POST /api/live/sessions/:id/end": { kind: "foreign", path: "/api/live/sessions/B-session/end" },

  "POST /api/users/": { kind: "gone" },
  "GET /api/users/": { kind: "scoped", repos: [] },

  "POST /api/meetings/": { kind: "scoped", body: { title: "t" }, repos: ["meeting.create"] },
  "GET /api/meetings/": { kind: "scoped", repos: ["meeting.findAll"] },
  "GET /api/meetings/:id": { kind: "foreign", path: M },
  "DELETE /api/meetings/:id": { kind: "foreign", path: M },
  "GET /api/meetings/:id/transcript": { kind: "foreign", path: `${M}/transcript` },
  "GET /api/meetings/:id/segments": { kind: "foreign", path: `${M}/segments` },
  "GET /api/meetings/:id/summary": { kind: "foreign", path: `${M}/summary` },
  "GET /api/meetings/:id/action-items": { kind: "foreign", path: `${M}/action-items` },
  "GET /api/meetings/:id/live": { kind: "foreign", path: `${M}/live` },
  "GET /api/meetings/:id/audio": { kind: "foreign", path: `${M}/audio` },
  "POST /api/meetings/:id/audio": { kind: "foreign", path: `${M}/audio` },
  "POST /api/meetings/:id/upload": { kind: "foreign", path: `${M}/upload` },
  "POST /api/meetings/:id/transcribe": { kind: "foreign", path: `${M}/transcribe` },
  "POST /api/meetings/:id/summarize": { kind: "foreign", path: `${M}/summarize` },
  "POST /api/meetings/:id/index": { kind: "foreign", path: `${M}/index` },

  "GET /api/meetings/:id/summary-review": { kind: "foreign", path: `${M}/summary-review` },
  "PATCH /api/meetings/:id/mode": { kind: "foreign", path: `${M}/mode`, body: { mode: "LECTURE" } },
  "POST /api/meetings/:id/resummarize": { kind: "foreign", path: `${M}/resummarize` },
  "POST /api/meetings/:id/action-items/:itemId/review": {
    kind: "foreign",
    path: `${M}/action-items/B-item/review`,
    body: { action: "accept" },
  },
  "GET /api/meetings/:id/speakers": { kind: "foreign", path: `${M}/speakers` },
  "PATCH /api/meetings/:id/speakers/:key": { kind: "foreign", path: `${M}/speakers/k`, body: { name: "x" } },
  "POST /api/meetings/:id/speakers/:key/accept": { kind: "foreign", path: `${M}/speakers/k/accept` },
  "POST /api/meetings/:id/process": { kind: "foreign", path: `${M}/process` },
  "POST /api/meetings/:id/retry": { kind: "foreign", path: `${M}/retry` },
  "GET /api/meetings/:id/events": { kind: "foreign", path: `${M}/events` },
  "GET /api/meetings/:id/export": { kind: "foreign", path: `${M}/export?format=pdf` },
  "POST /api/meetings/:id/export/email": { kind: "foreign", path: `${M}/export/email` },
  "PUT /api/meetings/:id/series": { kind: "foreign", path: `${M}/series`, body: { name: "x" } },
  "POST /api/meetings/:id/since-last-time/:itemId": {
    kind: "foreign",
    path: `${M}/since-last-time/B-item`,
    body: { action: "apply" },
  },

  "POST /api/transcripts/": { kind: "foreign", path: "/api/transcripts", body: { meetingId: "B-meeting", content: "x" } },
  "GET /api/transcripts/": { kind: "scoped", repos: ["transcript.findAll"] },

  "GET /api/analytics": {
    kind: "scoped",
    repos: [
      "meeting.stats",
      "meeting.countByStatus",
      "meeting.countBySource",
      "meeting.findSince",
      "meeting.findSummaryData",
      "actionItem.countByStatus",
      "actionItem.countAll",
      "actionItem.countOpenByOwner",
    ],
  },
  "GET /api/action-items": { kind: "scoped", repos: ["actionItem.findAll"] },
  "PATCH /api/action-items/:id": { kind: "foreign", path: "/api/action-items/B-item", body: { status: "COMPLETED" } },

  "GET /api/search": { kind: "scoped", path: "/api/search?q=budget", repos: ["embedding.search"] },
  "POST /api/chat": { kind: "scoped", body: { question: "what?" }, repos: ["chat.create", "embedding.search"] },
  "GET /api/chat/:id": { kind: "foreign", path: "/api/chat/B-thread" },

  "GET /api/account/settings": { kind: "scoped", repos: [] },
  "PATCH /api/account/settings": { kind: "scoped", body: { timezone: "Europe/London" }, repos: ["user.updateSettings"] },
  "GET /api/devices/": { kind: "scoped", repos: ["device.findByUser"] },
  "POST /api/devices/": { kind: "scoped", body: { name: "laptop", kind: "DESKTOP" }, repos: ["device.findByUser", "device.create"] },
  "POST /api/devices/:id/revoke": { kind: "foreign", path: "/api/devices/B-device/revoke" },
  "GET /api/series/": { kind: "scoped", repos: ["series.findByUser"] },
  "POST /api/series/": { kind: "scoped", body: { name: "Weekly" }, repos: ["series.findByName", "series.create"] },
  "PATCH /api/series/:id": { kind: "foreign", path: "/api/series/B-series", body: { name: "Mine now" } },
  "GET /api/series/:id/prep": { kind: "foreign", path: "/api/series/B-series/prep" },
};

/**
 * Mount points of routes/index.ts, in registration order. The test
 * below checks the index router has exactly this many sub-routers, so
 * a new router.use(...) must be added here (and classified above).
 */
const mounts = async (): Promise<[string, Router][]> => {
  const r = (m: { default: Router }) => m.default;
  const account = await import("../../src/routes/account.routes");
  return [
    ["/api/auth", r(await import("../../src/routes/auth.routes"))],
    ["/api/health", r(await import("../../src/routes/w3-jobs-health.routes"))],
    ["/api/live", r(await import("../../src/routes/live.routes"))],
    ["/api/users", r(await import("../../src/routes/user.routes"))],
    ["/api/meetings", r(await import("../../src/routes/meeting.routes"))],
    ["/api/transcripts", r(await import("../../src/routes/transcript.routes"))],
    ["/api/meetings", r(await import("../../src/routes/w1-sum.routes"))],
    ["/api/meetings", r(await import("../../src/routes/w2-spk.routes"))],
    ["/api/meetings", r(await import("../../src/routes/w3-jobs.routes"))],
    ["/api/account", account.accountRoutes],
    ["/api/devices", account.deviceRoutes],
    ["/api/series", account.seriesRoutes],
    ["/api/meetings", r(await import("../../src/routes/meetingExtras.routes"))],
  ];
};

type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } };

const routesOf = (prefix: string, router: Router): string[] =>
  (router.stack as Layer[]).flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods)
          .filter((m) => m !== "_all")
          .map((m) => `${m.toUpperCase()} ${prefix}${layer.route!.path}`)
      : []
  );

const registeredRoutes = async (): Promise<string[]> => {
  const index = (await import("../../src/routes/index")).default;
  const direct = routesOf("/api", index);
  const nested = (await mounts()).flatMap(([prefix, router]) => routesOf(prefix, router));
  return [...direct, ...nested];
};

const send = (method: string, path: string, user: string, body?: object) => {
  const call = request(app)[method.toLowerCase() as "get"](path).set("x-test-user", user);
  return body ? call.send(body) : call;
};

beforeEach(() => {
  seen.length = 0;
});

describe("every route is covered", () => {
  it("classifies every registered route and every mounted router", async () => {
    const index = (await import("../../src/routes/index")).default;
    const subRouters = (index.stack as Layer[]).filter((layer) => !layer.route && layer.handle?.stack);
    expect(subRouters.length).toBe((await mounts()).length);

    const registered = await registeredRoutes();
    const unclassified = registered.filter((route) => !(route in ROUTES));
    expect(unclassified).toEqual([]);

    const stale = Object.keys(ROUTES).filter((route) => !registered.includes(route));
    expect(stale).toEqual([]);
  });
});

describe("Alice cannot reach Bob's rows", () => {
  for (const [route, entry] of Object.entries(ROUTES)) {
    if (entry.kind !== "foreign") continue;

    it(`${route} with Bob's id is a 404`, async () => {
      const method = route.split(" ")[0];
      const res = await send(method, entry.path, ALICE, entry.body);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      // No repository list/create ran for Bob, or with Bob's id.
      expect(seen.filter((s) => s.userId === BOB)).toEqual([]);
    });
  }

  it("Bob's own ids work for Bob (the 404 above is about ownership)", async () => {
    const res = await send("GET", "/api/chat/B-thread", BOB);
    expect(res.status).toBe(200);
  });
});

describe("lists and creates are scoped to the caller", () => {
  for (const [route, entry] of Object.entries(ROUTES)) {
    if (entry.kind !== "scoped") continue;

    it(`${route} only asks for Alice's rows`, async () => {
      const [method, path] = route.split(" ");
      const res = await send(method, entry.path ?? path, ALICE, entry.body);

      expect(res.status).toBeLessThan(300);
      for (const fn of entry.repos) {
        const calls = seen.filter((s) => s.fn === fn);
        expect(calls.length, `${fn} was called`).toBeGreaterThan(0);
        expect(calls.every((c) => c.userId === ALICE), `${fn} used Alice's id`).toBe(true);
      }
      expect(seen.filter((s) => s.userId !== ALICE)).toEqual([]);
    });
  }

  it("GET /users returns only the caller", async () => {
    const res = await send("GET", "/api/users", ALICE);
    expect(res.body.data.map((u: { id: string }) => u.id)).toEqual([ALICE]);
  });

  it("a userId in the body cannot create a meeting for someone else", async () => {
    await send("POST", "/api/meetings", ALICE, { title: "t", userId: BOB });
    expect(seen.find((s) => s.fn === "meeting.create")?.userId).toBe(ALICE);
  });
});

describe("no session, no data", () => {
  for (const [route, entry] of Object.entries(ROUTES)) {
    if (entry.kind === "public" || entry.kind === "gone") continue;

    it(`${route} without a session is a 401`, async () => {
      const [method, path] = route.split(" ");
      const target = entry.kind === "foreign" ? entry.path : entry.path ?? path;
      const res = await send(method, target, "anonymous", entry.body);
      expect(res.status).toBe(401);
    });
  }
});
