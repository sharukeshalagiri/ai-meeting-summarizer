import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkId,
  classifyChunkResponse,
  createCaptureClient,
  type ChunkResponse,
  type QueuedChunk,
  type UploadOutcome,
} from "./contract.ts";
import { MemoryChunkStore, UploadQueue, backoffDelay } from "./uploadQueue.ts";

const SESSION = "s1";

const makeChunk = (seq: number, sessionId = SESSION): QueuedChunk => ({
  id: chunkId(sessionId, seq),
  sessionId,
  seq,
  startOffsetMs: seq * 20_000,
  durationMs: 20_000,
  channelLayout: "stereo-mic-left",
  mimeType: "audio/webm;codecs=opus",
  blob: new Blob([`audio-${seq}`], { type: "audio/webm" }),
  createdAt: 0,
  attempts: 0,
  nextAttemptAt: 0,
});

const response = (seq: number, duplicate = false): ChunkResponse => ({
  sessionId: SESSION,
  meetingId: "m1",
  seq,
  elapsedMs: (seq + 1) * 20_000,
  chunkCount: seq + 1,
  segments: [],
  rollingSummaryGenerated: false,
  duplicate,
});

const done = (seq: number, duplicate = false): UploadOutcome => ({
  kind: "done",
  duplicate,
  response: response(seq, duplicate),
});

/** Lets queued promise callbacks run without advancing the fake clock. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("UploadQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uploads in seq order and deletes only after the server confirms", async () => {
    const store = new MemoryChunkStore();
    const seen: number[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const queue = new UploadQueue({
      store,
      upload: async (chunk) => {
        seen.push(chunk.seq);
        // While the request is in flight the chunk is still stored.
        expect((await store.list()).map((c) => c.seq)).toContain(chunk.seq);
        await gate;
        return done(chunk.seq);
      },
    });

    await store.put(makeChunk(1));
    await store.put(makeChunk(0));
    queue.kick();
    await settle();

    expect((await store.list()).length).toBe(2);

    release();
    await vi.runAllTimersAsync();

    expect(seen).toEqual([0, 1]);
    expect(await store.list()).toEqual([]);
  });

  it("treats 409 as retry-later with backoff, never as a failure", async () => {
    const store = new MemoryChunkStore();
    const statuses = [409, 409, 200];
    const attemptsAt: number[] = [];

    const queue = new UploadQueue({
      store,
      upload: async (chunk) => {
        attemptsAt.push(Date.now());
        const status = statuses.shift()!;
        return status === 200
          ? done(chunk.seq)
          : classifyChunkResponse(status, { success: false, message: "Still processing" });
      },
    });

    await queue.enqueue(makeChunk(0));
    await settle();

    // Still stored and not marked failed after the first 409.
    const [stored] = await store.list();
    expect(stored.failed).toBeUndefined();
    expect(stored.attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(backoffDelay(1));
    await vi.advanceTimersByTimeAsync(backoffDelay(2));

    expect(attemptsAt).toEqual([0, 2_000, 6_000]);
    expect(await store.list()).toEqual([]);
  });

  it("treats duplicate:true as done", async () => {
    const store = new MemoryChunkStore();
    const uploaded = vi.fn();

    const queue = new UploadQueue({
      store,
      upload: async (chunk) => done(chunk.seq, true),
      onUploaded: uploaded,
    });

    await queue.enqueue(makeChunk(3));
    await settle();

    expect(await store.list()).toEqual([]);
    expect(uploaded).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 3 }),
      expect.objectContaining({ duplicate: true }),
      true
    );
  });

  it("keeps chunks while offline and uploads them when back online", async () => {
    const store = new MemoryChunkStore();
    let online = false;
    const upload = vi.fn(async (chunk: QueuedChunk): Promise<UploadOutcome> =>
      online ? done(chunk.seq) : { kind: "retry", status: null, reason: "Network error" }
    );

    const queue = new UploadQueue({ store, upload });

    await queue.enqueue(makeChunk(0));
    await queue.enqueue(makeChunk(1));
    await vi.advanceTimersByTimeAsync(60_000);

    const stored = await store.list();
    expect(stored.map((c) => c.seq).sort()).toEqual([0, 1]);
    expect((await queue.state()).lastRetry).toBe("Network error");

    online = true;
    queue.kick(); // the `online` event
    await vi.runAllTimersAsync();

    expect(await store.list()).toEqual([]);
  });

  it("caps backoff at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(backoffDelay)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("halts on 401 without deleting anything, and resumes", async () => {
    const store = new MemoryChunkStore();
    let token = "bad";
    const queue = new UploadQueue({
      store,
      upload: async (chunk) =>
        token === "bad" ? classifyChunkResponse(401, null) : done(chunk.seq),
    });

    await queue.enqueue(makeChunk(0));
    await queue.enqueue(makeChunk(1));
    await vi.advanceTimersByTimeAsync(60_000);

    expect((await queue.state()).halted).toBe("Device token rejected");
    expect((await store.list()).length).toBe(2);

    token = "good";
    queue.resume();
    await vi.runAllTimersAsync();

    expect(await store.list()).toEqual([]);
  });

  it("drops an ended session's chunks on 410 but keeps other sessions", async () => {
    const store = new MemoryChunkStore();
    const ended = vi.fn();
    const queue = new UploadQueue({
      store,
      upload: async (chunk) =>
        chunk.sessionId === "old" ? classifyChunkResponse(410, null) : done(chunk.seq),
      onSessionEnded: ended,
    });

    await store.put(makeChunk(0, "old"));
    await store.put(makeChunk(1, "old"));
    await store.put(makeChunk(0, "new"));
    queue.kick();
    await vi.runAllTimersAsync();

    expect(ended).toHaveBeenCalledWith("old", 2);
    expect(await store.list()).toEqual([]);
  });

  it("marks a 400 as failed, keeps it, and moves on", async () => {
    const store = new MemoryChunkStore();
    const queue = new UploadQueue({
      store,
      upload: async (chunk) =>
        chunk.seq === 0
          ? classifyChunkResponse(400, { success: false, message: "seq is required" })
          : done(chunk.seq),
    });

    await store.put(makeChunk(0));
    await store.put(makeChunk(1));
    queue.kick();
    await vi.runAllTimersAsync();

    const left = await store.list();
    expect(left.map((c) => [c.seq, c.failed])).toEqual([[0, "seq is required"]]);
    expect(await queue.state()).toMatchObject({ pending: 0, failed: 1 });
  });

  it("flush resolves with 0 once the session's chunks are in", async () => {
    const store = new MemoryChunkStore();
    let calls = 0;
    const queue = new UploadQueue({
      store,
      upload: async (chunk) =>
        ++calls < 3 ? { kind: "retry", status: 502, reason: "Bad gateway" } : done(chunk.seq),
    });

    await store.put(makeChunk(0));
    const flushed = queue.flush(SESSION, 60_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(flushed).resolves.toBe(0);
  });

  it("flush gives up at the timeout and reports what is left", async () => {
    const store = new MemoryChunkStore();
    const queue = new UploadQueue({
      store,
      upload: async () => ({ kind: "retry", status: null, reason: "Network error" }),
    });

    await store.put(makeChunk(0));
    await store.put(makeChunk(1));
    const flushed = queue.flush(SESSION, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(flushed).resolves.toBe(2);
  });
});

describe("UploadQueue across contexts (lost update)", () => {
  /**
   * Two uploaders share one IndexedDB store in the extension (offscreen
   * queue and worker drain). If the other one confirms and deletes the
   * chunk while this one's request is in flight, a retry or reject must
   * not write its stale copy back.
   */
  it.each([
    ["retry", { kind: "retry", status: 409, reason: "Still processing" }],
    ["reject", { kind: "reject", status: 400, reason: "bad" }],
  ] as const)("a %s after the chunk was confirmed elsewhere does not resurrect it", async (_name, late) => {
    const store = new MemoryChunkStore();
    let finish: (outcome: UploadOutcome) => void = () => undefined;
    const queue = new UploadQueue({
      store,
      upload: () => new Promise<UploadOutcome>((resolve) => (finish = resolve)),
    });

    await queue.enqueue(makeChunk(0));
    await settle();

    // Other context: 200 for the same seq, deletes it.
    await store.delete(chunkId(SESSION, 0));

    finish(late);
    await settle();

    expect(await store.list()).toEqual([]);
    queue.dispose();
  });

  it("a retry keeps attempts written by the other uploader (re-read, not stale copy)", async () => {
    const store = new MemoryChunkStore();
    let finish: (outcome: UploadOutcome) => void = () => undefined;
    const queue = new UploadQueue({
      store,
      upload: () => new Promise<UploadOutcome>((resolve) => (finish = resolve)),
    });

    await queue.enqueue(makeChunk(0));
    await settle();
    await store.update(chunkId(SESSION, 0), (c) => ({ ...c, attempts: 4 }));

    finish({ kind: "retry", status: 409, reason: "Still processing" });
    await settle();

    const [stored] = await store.list();
    expect(stored.attempts).toBe(5);
    queue.dispose();
  });
});

describe("classifyChunkResponse", () => {
  it("maps the contract table", () => {
    const ok = { success: true, message: "", data: response(0) };

    expect(classifyChunkResponse(200, ok).kind).toBe("done");
    expect(classifyChunkResponse(200, null).kind).toBe("retry");
    expect(classifyChunkResponse(409, null).kind).toBe("retry");
    expect(classifyChunkResponse(429, null).kind).toBe("retry");
    expect(classifyChunkResponse(502, null).kind).toBe("retry");
    expect(classifyChunkResponse(401, null).kind).toBe("halt");
    expect(classifyChunkResponse(410, null).kind).toBe("halt");
    expect(classifyChunkResponse(400, null).kind).toBe("reject");
    expect(classifyChunkResponse(413, null).kind).toBe("reject");
  });
});

describe("createCaptureClient.uploadChunk", () => {
  it("sends the contract fields and the Bearer token", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ success: true, message: "", data: response(2) }), {
          status: 200,
        })
    );
    const client = createCaptureClient({
      apiBase: "http://api.test/api/",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const outcome = await client.uploadChunk(makeChunk(2));

    expect(outcome.kind).toBe("done");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://api.test/api/live/sessions/s1/chunks");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");

    const form = init?.body as FormData;
    expect(form.get("seq")).toBe("2");
    expect(form.get("startOffsetMs")).toBe("40000");
    expect(form.get("durationMs")).toBe("20000");
    expect(form.get("channelLayout")).toBe("stereo-mic-left");
    expect((form.get("audio") as File).name).toBe("chunk-2.webm");
  });

  it("turns a network error into a retry", async () => {
    const client = createCaptureClient({
      apiBase: "http://api.test/api",
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });

    expect(await client.uploadChunk(makeChunk(0))).toMatchObject({
      kind: "retry",
      status: null,
    });
  });
});
