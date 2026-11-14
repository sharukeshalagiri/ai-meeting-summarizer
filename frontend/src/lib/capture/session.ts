import {
  CHUNK_FORMAT,
  chunkId,
  pickChunkMimeType,
  type CaptureClient,
  type ChunkResponse,
  type QueuedChunk,
} from "./contract.ts";
import { ChunkRecorder } from "./chunker.ts";
import { monitorLevels, type Levels } from "./levels.ts";
import { buildStereoMix, type StereoMix } from "./stereoMix.ts";
import { UploadQueue, type ChunkStore, type QueueState } from "./uploadQueue.ts";

/**
 * One recording: stereo mix -> 20 s chunks -> durable upload queue.
 * The web page (useLiveCapture) and the extension's offscreen document
 * both drive this, so the two recorders cannot drift apart.
 */

/** Mic constraints from the brief: the mic channel should carry only the user. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Asks for the mic; null (not an error) when it is denied or missing. */
export const getMicStream = async (): Promise<MediaStream | null> => {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  } catch {
    return null;
  }
};

export interface CaptureSessionOptions {
  sessionId: string;
  client: CaptureClient;
  store: ChunkStore;
  tab: MediaStream;
  mic: MediaStream | null;
  playTab?: boolean;
  onLevels?: (levels: Levels) => void;
  onQueue?: (state: QueueState) => void;
  onUploaded?: (response: ChunkResponse, duplicate: boolean) => void;
  onSessionEnded?: (droppedChunks: number) => void;
  onError?: (message: string) => void;
}

export interface CaptureSession {
  mix: StereoMix;
  queue: UploadQueue;
  elapsedMs(): number;
  setMicEnabled(enabled: boolean): void;
  /**
   * Stops recording, releases the streams, then waits up to
   * `flushTimeoutMs` for this session's chunks to upload. Resolves with
   * how many are still waiting (0 = safe to call /end).
   */
  stop(flushTimeoutMs: number): Promise<number>;
}

export const startCaptureSession = (options: CaptureSessionOptions): CaptureSession => {
  const ctx = new AudioContext({ sampleRate: CHUNK_FORMAT.sampleRate });
  const mix = buildStereoMix(ctx, {
    mic: options.mic,
    tab: options.tab,
    playTab: options.playTab,
  });

  const queue = new UploadQueue({
    store: options.store,
    upload: (chunk) => options.client.uploadChunk(chunk),
    onState: options.onQueue,
    onUploaded: (chunk, response, duplicate) =>
      chunk.sessionId === options.sessionId &&
      options.onUploaded?.(response, duplicate),
    onSessionEnded: (sessionId, dropped) =>
      sessionId === options.sessionId && options.onSessionEnded?.(dropped),
  });

  /**
   * Chunks still being written to the store. stop() waits for them
   * before flushing: otherwise the final chunk may not be stored yet,
   * flush sees 0 left, and /end goes out before the last 20 s upload.
   */
  const enqueues = new Set<Promise<unknown>>();

  const mimeType = pickChunkMimeType((type) => MediaRecorder.isTypeSupported(type));

  const recorder = new ChunkRecorder({
    stream: mix.stream,
    mimeType: mimeType || undefined,
    onChunk: (chunk) => {
      const queued: QueuedChunk = {
        id: chunkId(options.sessionId, chunk.seq),
        sessionId: options.sessionId,
        seq: chunk.seq,
        startOffsetMs: chunk.startOffsetMs,
        durationMs: chunk.durationMs,
        channelLayout: CHUNK_FORMAT.channelLayout,
        mimeType: chunk.mimeType,
        blob: chunk.blob,
        createdAt: Date.now(),
        attempts: 0,
        nextAttemptAt: 0,
      };

      const saving = queue
        .enqueue(queued)
        .catch(() =>
          options.onError?.("Could not save a chunk locally; it was not uploaded.")
        );

      enqueues.add(saving);
      void saving.finally(() => enqueues.delete(saving));
    },
    onError: () => options.onError?.("The recorder reported an error."),
  });

  const stopLevels = monitorLevels(mix, (levels) => options.onLevels?.(levels));

  // Back online: retry now instead of waiting out the backoff.
  const onOnline = () => queue.kick();

  globalThis.addEventListener?.("online", onOnline);

  recorder.start();
  queue.kick();

  return {
    mix,
    queue,
    elapsedMs: () => recorder.elapsedMs(),
    setMicEnabled: (enabled) => mix.setMicEnabled(enabled),
    async stop(flushTimeoutMs) {
      await recorder.stop();
      await Promise.all([...enqueues]);

      stopLevels();
      mix.disconnect();
      options.tab.getTracks().forEach((track) => track.stop());
      options.mic?.getTracks().forEach((track) => track.stop());
      void ctx.close().catch(() => undefined);

      const remaining = await queue.flush(options.sessionId, flushTimeoutMs);

      globalThis.removeEventListener?.("online", onOnline);
      queue.dispose();

      return remaining;
    },
  };
};
