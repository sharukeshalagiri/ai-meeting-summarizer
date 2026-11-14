// GENERATED from frontend/src/lib/capture/chunker.ts by
// extension/scripts/build-capture.mjs. Do not edit; edit the source.
import { CHUNK_FORMAT } from "./contract.js";
const defaultCreateRecorder = (stream, options) => new MediaRecorder(stream, options);
export class ChunkRecorder {
    options;
    now;
    seq = 0;
    origin = 0;
    current = null;
    timer = null;
    stopping = null;
    started = false;
    segments = new WeakMap();
    constructor(options) {
        this.options = options;
        this.now = options.now ?? (() => performance.now());
    }
    /** Recording-clock ms since start(); drives the UI timer too. */
    elapsedMs() {
        return this.started ? this.now() - this.origin : 0;
    }
    start() {
        this.origin = this.now();
        this.started = true;
        this.seq = 0;
        this.current = this.startSegment();
        this.schedule();
    }
    /** Stops and resolves once the final (partial) chunk has been emitted. */
    stop() {
        if (this.stopping)
            return this.stopping;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        const recorder = this.current;
        this.current = null;
        this.stopping = recorder ? this.finish(recorder) : Promise.resolve();
        return this.stopping;
    }
    schedule() {
        this.timer = setTimeout(() => this.rotate(), this.options.chunkMs ?? CHUNK_FORMAT.chunkMs);
    }
    /** Starts the next recorder before stopping the old one, keeping the gap minimal. */
    rotate() {
        const previous = this.current;
        if (!previous)
            return;
        try {
            this.current = this.startSegment();
        }
        catch (error) {
            this.options.onError?.(error);
        }
        void this.finish(previous);
        this.schedule();
    }
    startSegment() {
        const create = this.options.createRecorder ?? defaultCreateRecorder;
        const mimeType = this.options.mimeType ?? CHUNK_FORMAT.mimeType;
        const recorder = create(this.options.stream, {
            mimeType,
            audioBitsPerSecond: CHUNK_FORMAT.audioBitsPerSecond,
        });
        const seq = this.seq++;
        const startedAt = this.now();
        const parts = [];
        recorder.ondataavailable = (event) => {
            if (event.data.size > 0)
                parts.push(event.data);
        };
        recorder.onerror = (event) => this.options.onError?.(event);
        this.segments.set(recorder, { seq, startedAt, parts });
        recorder.start();
        return recorder;
    }
    finish(recorder) {
        const meta = this.segments.get(recorder);
        return new Promise((resolve) => {
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
            }
            else {
                recorder.stop();
            }
        });
    }
}
