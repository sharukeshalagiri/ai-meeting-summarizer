import type { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { DEMO_READ_ONLY_MESSAGE, demoReadOnly } from "../../src/middleware/demo.middleware";

const DEMO = { id: "demo", name: "Demo visitor", email: "demo@example.com" };

/**
 * The demo account is read-only on the server, for every route.
 *
 * Every registered route of the API is listed (the same way
 * test/w4-acct/isolation.test.ts does, plus the demo router), and every
 * one that is not GET/HEAD is sent as the demo account: each must be a
 * 403 with the read-only message, before any controller, repository or
 * upstream service runs. Only sign-out and sign-in pass. A new mutating
 * route anywhere is covered automatically.
 *
 * The test setup (setup.auth.ts) signs a request in as `<x-test-user>
 * @example.com`, so "demo" is the demo account (demo@example.com).
 */

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }));

// If the read-only check ever let a request through, these would record it.
vi.mock("../../src/services/embedding.service", () => ({
  embedQuery: vi.fn(async () => {
    touched.push("embedQuery");
    return [1, 0, 0];
  }),
  indexMeeting: vi.fn(async () => {
    touched.push("indexMeeting");
    return 0;
  }),
}));
vi.mock("../../src/repositories/embedding.repository", () => ({
  search: vi.fn(async () => []),
}));
vi.mock("../../src/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/gemini")>();
  return {
    ...actual,
    getClient: vi.fn(() => {
      touched.push("gemini");
      throw new Error("Gemini must not be called for the demo");
    }),
  };
});
vi.mock("../../src/repositories/meeting.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/repositories/meeting.repository")>();
  const record =
    (name: string, result: unknown) =>
    async () => {
      touched.push(`meeting.${name}`);
      return result;
    };
  return {
    ...actual,
    findAll: vi.fn(async () => []),
    create: vi.fn(record("create", { id: "x" })),
    remove: vi.fn(record("remove", {})),
    deleteById: vi.fn(record("deleteById", {})),
  };
});
vi.mock("../../src/demo/demo.repository", () => ({
  findDemoUser: vi.fn(async () => null),
  firstMeetingId: vi.fn(async () => null),
  findSegmentsContaining: vi.fn(async () => [
    {
      segmentId: "s1",
      meetingId: "m1",
      meetingTitle: "Search feature planning",
      meetingCreatedAt: new Date("2026-11-10T15:00:00Z"),
      speaker: "Marcus",
      text: "I'll have the search endpoint up by Friday.",
      startMs: 61_000,
      endMs: 64_000,
    },
  ]),
}));

const app = createApp();

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

const allRoutes = async (): Promise<string[]> => {
  const index = (await import("../../src/routes/index")).default;
  const subRouters = (index.stack as Layer[]).filter((layer) => !layer.route && layer.handle?.stack);
  // A new router mounted in routes/index.ts must be added to mounts().
  expect(subRouters.length).toBe((await mounts()).length);

  const demo = (await import("../../src/routes/w5-demo.routes")).demoRouter;
  const all = [
    ...routesOf("/api", index),
    ...(await mounts()).flatMap(([prefix, router]) => routesOf(prefix, router)),
    ...routesOf("/api/demo", demo),
  ];
  return [...new Set(all)];
};

const concrete = (path: string) =>
  path
    .replace(/\/$/, "")
    .replace(/:id/g, "demo-meeting")
    .replace(/:itemId/g, "demo-item")
    .replace(/:key/g, "speaker-1");

const send = (method: string, path: string, user = "demo") =>
  request(app)[method.toLowerCase() as "post"](path).set("x-test-user", user).send({ name: "x", title: "x", mode: "LECTURE" });

const ALLOWED = new Set(["POST /api/auth/logout", "POST /api/auth/login"]);

beforeEach(() => {
  touched.length = 0;
});

describe("the demo account is read-only on every route", async () => {
  const routes = await allRoutes();
  const writes = routes.filter((route) => !route.startsWith("GET ") && !ALLOWED.has(route));

  it("finds the mutating routes (uploads, deletes, settings, devices, chat, exports...)", () => {
    for (const expected of [
      "POST /api/meetings/",
      "DELETE /api/meetings/:id",
      "POST /api/meetings/:id/audio",
      "POST /api/meetings/:id/process",
      "POST /api/meetings/:id/resummarize",
      "PATCH /api/meetings/:id/speakers/:key",
      "PATCH /api/account/settings",
      "POST /api/devices/",
      "POST /api/meetings/:id/export/email",
      "POST /api/chat",
      "POST /api/live/sessions",
      "POST /api/auth/password",
    ]) {
      expect(writes).toContain(expected);
    }
    expect(writes.length).toBeGreaterThan(30);
  });

  for (const route of writes) {
    it(`${route} is refused for the demo account`, async () => {
      const [method, path] = route.split(" ");
      const res = await send(method, concrete(path));

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, message: DEMO_READ_ONLY_MESSAGE });
      expect(touched).toEqual([]);
    });
  }

  it("also refuses the same routes with a trailing slash or other casing", async () => {
    for (const [method, path] of [
      ["DELETE", "/api/meetings/demo-meeting/"],
      ["PATCH", "/api/ACCOUNT/settings"],
      ["POST", "/api/Devices"],
    ]) {
      expect((await send(method, path)).status).toBe(403);
    }
  });

  it("does not affect any other account", async () => {
    const res = await send("POST", "/api/meetings", "someone");
    expect(res.status).not.toBe(403);
  });

  it("still lets the demo account read", async () => {
    expect((await send("GET", "/api/meetings")).status).toBe(200);
  });

  it("lets the demo account sign out or sign in elsewhere (no database here, so called directly)", () => {
    for (const path of ["/auth/logout", "/auth/login", "/auth/logout/"]) {
      const next = vi.fn();
      demoReadOnly({ method: "POST", path, user: DEMO, header: () => undefined } as never, {} as never, next);
      expect(next).toHaveBeenCalledWith();
    }
    const next = vi.fn();
    demoReadOnly({ method: "POST", path: "/auth/password", user: DEMO, header: () => undefined } as never, {} as never, next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });
});

describe("demo search never calls Gemini", () => {
  it("answers GET /search for the demo account with a keyword search", async () => {
    const res = await request(app).get("/api/search?q=search%20endpoint").set("x-test-user", "demo");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ segmentId: "s1", speaker: "Marcus", startMs: 61_000, score: 1, timestamp: expect.any(String) }),
    ]);
    expect(touched).toEqual([]);
  });

  it("leaves everyone else on semantic search", async () => {
    await request(app).get("/api/search?q=budget").set("x-test-user", "someone");
    expect(touched).toContain("embedQuery");
  });
});
