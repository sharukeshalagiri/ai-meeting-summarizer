import request from "supertest";
import { createApp } from "../../src/app";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as access from "../../src/repositories/access.repository";
import * as fakes from "../helpers/liveFakes";

/**
 * Per-user device tokens through the real routes, middleware and
 * devices.service, with an in-memory DeviceToken table and the live
 * capture fakes. The recorders' requests are reproduced byte for byte:
 * - extension (extension/lib/capture/contract.js): multipart "audio",
 *   seq, startOffsetMs, durationMs, channelLayout; source EXTENSION;
 * - desktop recorder (desktop-recorder/.../api.py upload_chunk): the
 *   same fields; source DESKTOP;
 * both with `Authorization: Bearer <token>`. A revoked token must be
 * rejected on every one of their paths.
 */

type Row = {
  id: string;
  userId: string;
  name: string;
  kind: string;
  tokenHash: string;
  prefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};
const tokens: Row[] = [];
// Ids unique across tests: devices.service throttles lastUsedAt per id.
let nextId = 0;
const publicRow = ({ tokenHash: _hash, userId: _user, ...rest }: Row) => rest;
const USERS: Record<string, { id: string; name: string; email: string }> = {
  alice: { id: "alice", name: "Alice", email: "alice@example.com" },
  bob: { id: "bob", name: "Bob", email: "bob@example.com" },
};

vi.mock("../../src/repositories/deviceToken.repository", () => ({
  create: async (data: Omit<Row, "id" | "lastUsedAt" | "revokedAt" | "createdAt">) => {
    const row: Row = { ...data, id: `dev-${++nextId}`, lastUsedAt: null, revokedAt: null, createdAt: new Date() };
    tokens.push(row);
    return publicRow(row);
  },
  findByUser: async (userId: string) => tokens.filter((t) => t.userId === userId).map(publicRow),
  findOwned: async (id: string, userId: string) => {
    const row = tokens.find((t) => t.id === id && t.userId === userId);
    return row ? publicRow(row) : null;
  },
  findByHash: async (hash: string) => {
    const row = tokens.find((t) => t.tokenHash === hash);
    return row ? { id: row.id, revokedAt: row.revokedAt, user: USERS[row.userId] } : null;
  },
  revoke: async (id: string, userId: string) => {
    const row = tokens.find((t) => t.id === id && t.userId === userId && !t.revokedAt);
    if (row) row.revokedAt = new Date();
    return { count: row ? 1 : 0 };
  },
  markUsed: async (id: string) => {
    const row = tokens.find((t) => t.id === id);
    if (row) row.lastUsedAt = new Date();
    return { id };
  },
}));

// Live capture fakes, as in test/captureContract.test.ts.
vi.mock("../../src/repositories/liveSession.repository", async () => (await import("../helpers/liveFakes")).liveSessionRepo);
vi.mock("../../src/repositories/liveChunk.repository", async () => (await import("../helpers/liveFakes")).liveChunkRepo);
vi.mock("../../src/repositories/segment.repository", async () => (await import("../helpers/liveFakes")).segmentRepo);
vi.mock("../../src/repositories/meeting.repository", async () => (await import("../helpers/liveFakes")).meetingRepo);
vi.mock("../../src/repositories/transcript.repository", async () => (await import("../helpers/liveFakes")).transcriptRepo);
vi.mock("../../src/services/speech.service", async () => (await import("../helpers/liveFakes")).speechService);
vi.mock("../../src/services/diarization.service", async () => (await import("../helpers/liveFakes")).diarizationService);
vi.mock("../../src/services/summary.service", async () => (await import("../helpers/liveFakes")).summaryService);

/** Which account each meeting was created for. */
const meetingOwner = new Map<string, string>();
vi.mock("../../src/services/meeting.service", async () => {
  const f = (await import("../helpers/liveFakes")).meetingService;
  return {
    ...f,
    createMeeting: async (input: { title: string; mode?: string; userId: string }) => {
      const meeting = await f.createMeeting(input);
      meetingOwner.set(meeting.id, input.userId);
      return meeting;
    },
  };
});


const app = createApp();

const createToken = async (user: string, kind: string) => {
  const res = await request(app).post("/api/devices").set("x-test-user", user).send({ name: `${kind} of ${user}`, kind });
  expect(res.status).toBe(201);
  return res.body.data as { token: string; device: { id: string } };
};

const startSession = (token: string, source: "EXTENSION" | "DESKTOP") =>
  request(app)
    .post("/api/live/sessions")
    .set("Authorization", `Bearer ${token}`)
    .send({ title: "Standup", platform: source === "DESKTOP" ? "ZOOM" : "MEET", source, mode: "AUTO", hints: [] });

/** The exact multipart both recorders send. */
const uploadChunk = (token: string, sessionId: string, seq: number) =>
  request(app)
    .post(`/api/live/sessions/${sessionId}/chunks`)
    .set("Authorization", `Bearer ${token}`)
    .field("seq", String(seq))
    .field("startOffsetMs", String(seq * 20_000))
    .field("durationMs", "20000")
    .field("channelLayout", "stereo-mic-left")
    .attach("audio", Buffer.from(`chunk ${seq}`), { filename: `chunk-${seq}.webm`, contentType: "audio/webm" });

beforeEach(() => {
  fakes.reset();
  tokens.length = 0;
  meetingOwner.clear();
  // A session belongs to the account its meeting was created for.
  vi.mocked(access.liveSessionOwnerId).mockImplementation(async (sessionId: string) => {
    const session = fakes.store.sessions.get(sessionId);
    return session ? meetingOwner.get(session.meetingId) ?? null : null;
  });
});

describe("Devices page API", () => {
  it("shows the token once and stores only its hash", async () => {
    const { token, device } = await createToken("alice", "EXTENSION");

    expect(token).toMatch(/^amsd_[A-Za-z0-9_-]{43}$/);
    expect(tokens[0].tokenHash).not.toContain(token);
    expect(tokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await request(app).get("/api/devices").set("x-test-user", "alice");
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body.data)).not.toContain(token);
    expect(list.body.data[0]).toMatchObject({ id: device.id, kind: "EXTENSION", prefix: token.slice(0, 9) });
  });

  it("rejects an unknown kind", async () => {
    const res = await request(app).post("/api/devices").set("x-test-user", "alice").send({ name: "x", kind: "PHONE" });
    expect(res.status).toBe(400);
  });
});

describe.each(["EXTENSION", "DESKTOP"] as const)("%s recorder", (source) => {
  it("captures into the token owner's account", async () => {
    const { token } = await createToken("alice", source);

    const started = await startSession(token, source);
    expect(started.status).toBe(201);
    expect(meetingOwner.get(started.body.data.meetingId)).toBe("alice");

    const chunk = await uploadChunk(token, started.body.data.sessionId, 0);
    expect(chunk.status).toBe(200);
    expect(tokens[0].lastUsedAt).not.toBeNull();
  });

  it("is rejected on every path once its token is revoked", async () => {
    const { token, device } = await createToken("alice", source);
    const started = await startSession(token, source);
    const { sessionId } = started.body.data;
    expect((await uploadChunk(token, sessionId, 0)).status).toBe(200);

    const revoked = await request(app).post(`/api/devices/${device.id}/revoke`).set("x-test-user", "alice");
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.revokedAt).toBeTruthy();

    const chunk = await uploadChunk(token, sessionId, 1);
    expect(chunk.status).toBe(401);
    expect(chunk.body.message).toMatch(/invalid or revoked/i);
    // Nothing from the rejected upload was stored.
    expect(fakes.store.chunks.map((c) => c.seq)).toEqual([0]);

    // The other recorder calls are refused too.
    expect((await startSession(token, source)).status).toBe(401);
    const roster = await request(app)
      .post(`/api/live/sessions/${sessionId}/roster`)
      .set("Authorization", `Bearer ${token}`)
      .send({ participants: ["Bob"] });
    expect(roster.status).toBe(401);
    const end = await request(app).post(`/api/live/sessions/${sessionId}/end`).set("Authorization", `Bearer ${token}`).send({});
    expect(end.status).toBe(401);
  });

  it("cannot upload into another account's session", async () => {
    const alice = await createToken("alice", source);
    const bob = await createToken("bob", source);
    const started = await startSession(alice.token, source);

    const res = await uploadChunk(bob.token, started.body.data.sessionId, 0);
    expect(res.status).toBe(404);
    expect(fakes.store.chunks).toHaveLength(0);
  });
});

describe("revocation is per account", () => {
  it("Bob cannot revoke Alice's token, and it keeps working", async () => {
    const { token, device } = await createToken("alice", "DESKTOP");

    const res = await request(app).post(`/api/devices/${device.id}/revoke`).set("x-test-user", "bob");
    expect(res.status).toBe(404);
    expect(tokens[0].revokedAt).toBeNull();
    expect((await startSession(token, "DESKTOP")).status).toBe(201);
  });

  it("revoking one device leaves the others working", async () => {
    const ext = await createToken("alice", "EXTENSION");
    const desk = await createToken("alice", "DESKTOP");

    await request(app).post(`/api/devices/${ext.device.id}/revoke`).set("x-test-user", "alice");

    expect((await startSession(ext.token, "EXTENSION")).status).toBe(401);
    expect((await startSession(desk.token, "DESKTOP")).status).toBe(201);
  });
});
