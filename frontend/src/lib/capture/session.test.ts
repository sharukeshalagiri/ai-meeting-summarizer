import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureClient, QueuedChunk, UploadOutcome } from "./contract.ts";
import { startCaptureSession } from "./session.ts";
import { MemoryChunkStore } from "./uploadQueue.ts";

/** Just enough Web Audio for buildStereoMix and monitorLevels. */
const fakeNode = () => ({
  connect: () => undefined,
  disconnect: () => undefined,
  gain: { value: 1 },
  fftSize: 32,
  channelCount: 2,
  stream: {},
  getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0),
});

class FakeAudioContext {
  destination = fakeNode();
  createChannelMerger = fakeNode;
  createMediaStreamDestination = fakeNode;
  createMediaStreamSource = fakeNode;
  createGain = fakeNode;
  createAnalyser = fakeNode;
  close = async () => undefined;
}

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["final"]) });
      this.onstop?.();
    });
  }
}

/** A store whose put is slow, like IndexedDB under load. */
class SlowPutStore extends MemoryChunkStore {
  async put(chunk: QueuedChunk) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await super.put(chunk);
  }
}

const fakeStream = () =>
  ({ getTracks: () => [], getAudioTracks: () => [{}] }) as unknown as MediaStream;

describe("startCaptureSession stop()", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reports 0 left only after the final chunk is stored and uploaded (drain before /end)", async () => {
    const uploaded: number[] = [];
    const client = {
      uploadChunk: async (chunk: QueuedChunk): Promise<UploadOutcome> => {
        uploaded.push(chunk.seq);
        return {
          kind: "done",
          duplicate: false,
          response: {
            sessionId: "s1",
            meetingId: "m1",
            elapsedMs: 0,
            chunkCount: 1,
            segments: [],
            rollingSummaryGenerated: false,
          },
        };
      },
    } as unknown as CaptureClient;

    const capture = startCaptureSession({
      sessionId: "s1",
      client,
      store: new SlowPutStore(),
      tab: fakeStream(),
      mic: null,
    });

    // Stop right away: the only chunk is the partial one emitted on stop,
    // and its put takes 50 ms.
    const remaining = await capture.stop(5_000);

    expect(remaining).toBe(0);
    expect(uploaded).toEqual([0]);
  });
});
