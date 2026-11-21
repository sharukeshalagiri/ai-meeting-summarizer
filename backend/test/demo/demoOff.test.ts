import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";

/** DEMO_MODE is off by default: no button, and no way in. */

vi.mock("../../src/demo/demo.repository", () => ({
  findDemoUser: vi.fn(async () => ({ id: "demo-id", name: "Demo visitor", email: "demo@example.com" })),
  firstMeetingId: vi.fn(async () => null),
  findSegmentsContaining: vi.fn(async () => []),
}));

const app = createApp();

describe("demo mode off", () => {
  it("reports it, and refuses the demo sign-in", async () => {
    expect((await request(app).get("/api/demo").set("x-test-user", "anonymous")).body.data).toEqual({
      enabled: false,
      readOnly: true,
    });
    const res = await request(app).post("/api/demo/login").set("x-test-user", "anonymous");
    expect(res.status).toBe(404);
  });
});
