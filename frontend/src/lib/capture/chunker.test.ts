import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkRecorder, type RecordedChunk, type RecorderLike } from "./chunker.ts";
import { CHUNK_FORMAT, parseHints, pickChunkMimeType } from "./contract.ts";

class FakeRecorder implements RecorderLike {
  static created: FakeRecorder[] = [];
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  options: MediaRecorderOptions;

  constructor(options: MediaRecorderOptions) {
    this.options = options;
    FakeRecorder.created.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    // MediaRecorder emits the data, then stop, asynchronously.
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["x"]) });
      this.onstop?.();
    });
  }
}

describe("ChunkRecorder", () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
    FakeRecorder.created = [];
  });

  afterEach(() => vi.useRealTimers());

  it("emits standalone chunks with seq and recording-clock offsets", async () => {
    const chunks: RecordedChunk[] = [];
    const recorder = new ChunkRecorder({
      stream: {} as MediaStream,
      onChunk: (chunk) => chunks.push(chunk),
      createRecorder: (_stream, options) => new FakeRecorder(options),
      now: () => now,
    });

    recorder.start();

    for (let i = 0; i < 2; i++) {
      now += CHUNK_FORMAT.chunkMs;
      await vi.advanceTimersByTimeAsync(CHUNK_FORMAT.chunkMs);
    }

    now += 5_000;
    await recorder.stop();

    expect(chunks.map(({ seq, startOffsetMs, durationMs }) => ({ seq, startOffsetMs, durationMs }))).toEqual([
      { seq: 0, startOffsetMs: 0, durationMs: 20_000 },
      { seq: 1, startOffsetMs: 20_000, durationMs: 20_000 },
      { seq: 2, startOffsetMs: 40_000, durationMs: 5_000 },
    ]);
    // One MediaRecorder per chunk: each blob has its own container header.
    expect(FakeRecorder.created).toHaveLength(3);
    expect(FakeRecorder.created[0].options).toMatchObject({
      mimeType: CHUNK_FORMAT.mimeType,
      audioBitsPerSecond: CHUNK_FORMAT.audioBitsPerSecond,
    });
  });
});

describe("contract helpers", () => {
  it("parses hints: split, trim, de-dupe, cap", () => {
    expect(parseHints("Priya, Kubernetes\n priya ,,Q3 roadmap")).toEqual([
      "Priya",
      "Kubernetes",
      "Q3 roadmap",
    ]);
    expect(parseHints(Array.from({ length: 30 }, (_, i) => `t${i}`).join(","))).toHaveLength(20);
  });

  it("prefers the contract mime type", () => {
    expect(pickChunkMimeType(() => true)).toBe(CHUNK_FORMAT.mimeType);
    expect(pickChunkMimeType((t) => t === "audio/ogg;codecs=opus")).toBe("audio/ogg;codecs=opus");
    expect(pickChunkMimeType(() => false)).toBe("");
  });
});
