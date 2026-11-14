// GENERATED from frontend/src/lib/capture/contract.ts by
// extension/scripts/build-capture.mjs. Do not edit; edit the source.
/**
 * Capture contract client (docs/CAPTURE_CONTRACT.md) shared by the web
 * page and the Chrome extension.
 *
 * Everything in lib/capture is framework-free and reads no build-time
 * env (no import.meta.env): extension/scripts/build-capture.mjs
 * transpiles these files verbatim into extension/lib/capture/, where
 * there is no bundler. Callers pass apiBase and the device token in.
 */
/**
 * The one place the chunk format is decided. Every recorder (web page,
 * extension, desktop recorder) must produce chunks like these.
 *
 * - 20 s: Whisper needs enough context to punctuate, and every chunk
 *   costs a round trip plus a diarization call.
 * - WebM/Opus, 48 kHz, 2 channels: what MediaRecorder produces natively
 *   in Chrome; ffmpeg decodes it. The container is pending an engineer
 *   decision (the desktop recorder proposes Ogg/Opus, same codec).
 * - Each chunk is a standalone file: the recorder is stopped and
 *   restarted per chunk (see chunker.ts), never sliced with a timeslice.
 */
export const CHUNK_FORMAT = {
    chunkMs: 20_000,
    mimeType: "audio/webm;codecs=opus",
    fileExtension: "webm",
    sampleRate: 48_000,
    channels: 2,
    audioBitsPerSecond: 128_000,
    channelLayout: "stereo-mic-left",
};
/** Order and labels of the mode picker in the web page and the popup. */
export const MEETING_MODES = [
    { value: "AUTO", label: "Auto" },
    { value: "GENERAL", label: "General" },
    { value: "LECTURE", label: "Lecture" },
    { value: "INTERVIEW", label: "Interview" },
    { value: "PROJECT", label: "Project" },
    { value: "ONE_ON_ONE", label: "1:1" },
];
/** Contract limits for hints (backend/src/types/capture.ts LIMITS). */
export const HINT_LIMITS = { count: 20, length: 500 };
/**
 * "Names and terms" box -> contract hints: split on commas and new
 * lines, trimmed, de-duplicated (case-insensitive) and capped to the
 * contract limits so the session request never fails on them.
 */
export const parseHints = (text) => {
    const seen = new Set();
    const hints = [];
    for (const raw of text.split(/[\n,]/)) {
        const hint = raw.trim().slice(0, HINT_LIMITS.length);
        const key = hint.toLowerCase();
        if (!hint || seen.has(key))
            continue;
        seen.add(key);
        hints.push(hint);
        if (hints.length === HINT_LIMITS.count)
            break;
    }
    return hints;
};
/** First MediaRecorder type the browser supports, preferring the contract format. */
export const pickChunkMimeType = (isTypeSupported) => {
    const candidates = [
        CHUNK_FORMAT.mimeType,
        "audio/webm",
        "audio/ogg;codecs=opus",
    ];
    return candidates.find((type) => isTypeSupported(type)) ?? "";
};
/** File extension for a recorded type: ffmpeg infers the container from it. */
export const extensionForMime = (mimeType) => {
    if (mimeType.includes("ogg"))
        return "ogg";
    if (mimeType.includes("mp4"))
        return "m4a";
    return CHUNK_FORMAT.fileExtension;
};
export const chunkId = (sessionId, seq) => `${sessionId}:${seq}`;
/** Maps an HTTP status and parsed body to the queue's next step. */
export const classifyChunkResponse = (status, body) => {
    const reason = body?.message || `HTTP ${status}`;
    if (status >= 200 && status < 300) {
        if (body?.success && body.data) {
            return {
                kind: "done",
                duplicate: Boolean(body.data.duplicate),
                response: body.data,
            };
        }
        // A 2xx without our envelope is a proxy or captive portal page:
        // the chunk did not reach the backend.
        return { kind: "retry", status, reason: "Unexpected response" };
    }
    if (status === 409 || status === 408 || status === 425 || status === 429) {
        return { kind: "retry", status, reason };
    }
    if (status >= 500)
        return { kind: "retry", status, reason };
    if (status === 401 || status === 403) {
        return { kind: "halt", status, reason: "Device token rejected" };
    }
    if (status === 410) {
        return { kind: "halt", status, reason: "Session already ended" };
    }
    return { kind: "reject", status, reason };
};
/** Error carrying the HTTP status, so callers can tell 401 from offline. */
export class CaptureHttpError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "CaptureHttpError";
        this.status = status;
    }
}
/**
 * Thin fetch client for /api/live. fetch rather than axios so the same
 * code runs in the extension's service worker and offscreen document.
 */
export const createCaptureClient = (options) => {
    const base = options.apiBase.replace(/\/+$/, "");
    const doFetch = options.fetchImpl ?? ((...args) => fetch(...args));
    const authHeaders = () => options.token ? { Authorization: `Bearer ${options.token}` } : {};
    const readJson = async (response) => {
        try {
            return (await response.json());
        }
        catch {
            return null;
        }
    };
    const postJson = async (path, body) => {
        let response;
        try {
            response = await doFetch(`${base}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders() },
                body: JSON.stringify(body ?? {}),
            });
        }
        catch {
            throw new CaptureHttpError(`Could not reach the backend at ${base}.`, null);
        }
        const payload = await readJson(response);
        if (!response.ok || !payload?.success || payload.data === undefined) {
            throw new CaptureHttpError(payload?.message || `Request failed (${response.status})`, response.status);
        }
        return payload.data;
    };
    const uploadChunk = async (chunk) => {
        const form = new FormData();
        form.append("audio", chunk.blob, `chunk-${chunk.seq}.${extensionForMime(chunk.mimeType)}`);
        form.append("seq", String(chunk.seq));
        form.append("startOffsetMs", String(Math.round(chunk.startOffsetMs)));
        form.append("durationMs", String(Math.round(chunk.durationMs)));
        form.append("channelLayout", chunk.channelLayout);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.chunkTimeoutMs ?? 5 * 60_000);
        try {
            const response = await doFetch(`${base}/live/sessions/${encodeURIComponent(chunk.sessionId)}/chunks`, {
                method: "POST",
                headers: authHeaders(),
                body: form,
                signal: controller.signal,
            });
            return classifyChunkResponse(response.status, await readJson(response));
        }
        catch {
            // Offline, DNS, CORS or our own timeout: the chunk may or may
            // not have arrived; the server's idempotency makes a retry safe.
            return { kind: "retry", status: null, reason: "Network error" };
        }
        finally {
            clearTimeout(timer);
        }
    };
    return {
        apiBase: base,
        startSession: (input) => postJson("/live/sessions", input),
        uploadChunk,
        sendRoster: (sessionId, participants) => postJson(`/live/sessions/${encodeURIComponent(sessionId)}/roster`, { participants }),
        endSession: (sessionId) => postJson(`/live/sessions/${encodeURIComponent(sessionId)}/end`, {}),
    };
};
