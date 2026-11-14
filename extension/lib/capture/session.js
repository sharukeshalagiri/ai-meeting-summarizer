// GENERATED from frontend/src/lib/capture/session.ts by
// extension/scripts/build-capture.mjs. Do not edit; edit the source.
import { CHUNK_FORMAT, chunkId, pickChunkMimeType, } from "./contract.js";
import { ChunkRecorder } from "./chunker.js";
import { monitorLevels } from "./levels.js";
import { buildStereoMix } from "./stereoMix.js";
import { UploadQueue } from "./uploadQueue.js";
/**
 * One recording: stereo mix -> 20 s chunks -> durable upload queue.
 * The web page (useLiveCapture) and the extension's offscreen document
 * both drive this, so the two recorders cannot drift apart.
 */
/** Mic constraints from the brief: the mic channel should carry only the user. */
export const MIC_CONSTRAINTS = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
};
/** Asks for the mic; null (not an error) when it is denied or missing. */
export const getMicStream = async () => {
    try {
        return await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
    }
    catch {
        return null;
    }
};
export const startCaptureSession = (options) => {
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
        onUploaded: (chunk, response, duplicate) => chunk.sessionId === options.sessionId &&
            options.onUploaded?.(response, duplicate),
        onSessionEnded: (sessionId, dropped) => sessionId === options.sessionId && options.onSessionEnded?.(dropped),
    });
    const mimeType = pickChunkMimeType((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new ChunkRecorder({
        stream: mix.stream,
        mimeType: mimeType || undefined,
        onChunk: (chunk) => {
            const queued = {
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
            queue.enqueue(queued).catch(() => options.onError?.("Could not save a chunk locally; it was not uploaded."));
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
