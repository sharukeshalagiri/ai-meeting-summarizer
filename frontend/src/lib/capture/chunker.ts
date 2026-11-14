import { CHUNK_FORMAT } from "./contract.ts";

/**
 * Cuts a stream into standalone chunks by stopping and restarting the
 * MediaRecorder every `chunkMs`.
 *
 * Why not `recorder.start(timeslice)`: only the first timeslice blob
 * carries the WebM header, so every later blob is undecodable on its
 * own. That only worked while chunks were uploaded strictly in order and
 * never retried; with a durable queue each chunk must be a valid file.
 * The cost is a gap of a few milliseconds between chunks.
 *
 * Offsets come from the recording clock (`now`), not upload time, as the
 * contract requires.
 */

export interface RecordedChunk {
  seq: number;
  startOffsetMs: number;
  durationMs: number;
  blob: Blob;
  mimeType: string;
}

/** The MediaRecorder surface this module uses (a fake in tests). */
export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(): void;
  stop(): void;
}

export interface ChunkRecorderOptions {
  stream: MediaStream;
  onChunk: (chunk: RecordedChunk) => void;
  onError?: (error: unknown) => void;
  chunkMs?: number;
  mimeType?: string;
  createRecorder?: (stream: MediaStream, options: MediaRecorderOptions) => RecorderLike;
  now?: () => number;
}

const defaultCreateRecorder = (
  stream: MediaStream,
  options: MediaRecorderOptions
): RecorderLike => new MediaRecorder(stream, options) as unknown as RecorderLike;

export class ChunkRecorder {
  private options: ChunkRecorderOptions;
  private now: () => number;
  private seq = 0;
  private origin = 0;
  private current: RecorderLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private started = false;
  private segments = new WeakMap<
    RecorderLike,
    { seq: number; startedAt: number; parts: Blob[] }
  >();

  constructor(options: ChunkRecorderOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  /** Recording-clock ms since start(); drives the UI timer too. */
  elapsedMs(): number {
    return this.started ? this.now() - this.origin : 0;
  }

  start(): void {
    this.origin = this.now();
    this.started = true;
    this.seq = 0;
    this.current = this.startSegment();
    this.schedule();
  }

  /** Stops and resolves once the final (partial) chunk has been emitted. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const recorder = this.current;

    this.current = null;
    this.stopping = recorder ? this.finish(recorder) : Promise.resolve();

    return this.stopping;
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.rotate(), this.options.chunkMs ?? CHUNK_FORMAT.chunkMs);
  }

  /** Starts the next recorder before stopping the old one, keeping the gap minimal. */
  private rotate(): void {
    const previous = this.current;

    if (!previous) return;

    try {
      this.current = this.startSegment();
    } catch (error) {
      this.options.onError?.(error);
    }

    void this.finish(previous);
    this.schedule();
  }

  private startSegment(): RecorderLike {
    const create = this.options.createRecorder ?? defaultCreateRecorder;
    const mimeType = this.options.mimeType ?? CHUNK_FORMAT.mimeType;
    const recorder = create(this.options.stream, {
      mimeType,
      audioBitsPerSecond: CHUNK_FORMAT.audioBitsPerSecond,
    });
    const seq = this.seq++;
    const startedAt = this.now();
    const parts: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    recorder.onerror = (event) => this.options.onError?.(event);
    this.segments.set(recorder, { seq, startedAt, parts });

    recorder.start();

    return recorder;
  }

  private finish(recorder: RecorderLike): Promise<void> {
    const meta = this.segments.get(recorder);

    return new Promise<void>((resolve) => {
      const stoppedAt = this.now();

      recorder.onstop = () => {
        // An empty segment (a stop right after a rotation) is skipped;
        // its seq is simply never sent, which the contract allows.
        if (meta && meta.parts.length) {
          const type = recorder.mimeType || this.options.mimeType || CHUNK_FORMAT.mimeType;

          this.options.onChunk({
            seq: meta.seq,
            startOffsetMs: Math.round(meta.startedAt - this.origin),
            durationMs: Math.max(1, Math.round(stoppedAt - meta.startedAt)),
            blob: new Blob(meta.parts, { type }),
            mimeType: type,
          });
        }

        resolve();
      };

      if (recorder.state === "inactive") {
        recorder.onstop();
      } else {
        recorder.stop();
      }
    });
  }
}
