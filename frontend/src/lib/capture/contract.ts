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
} as const;

/** Left channel = the user's mic, right = everyone else. */
export type ChannelLayout = "stereo-mic-left" | "mono";

export type CaptureSource = "EXTENSION" | "DESKTOP" | "WEB" | "BOT";

export type MeetingMode =
  | "AUTO"
  | "GENERAL"
  | "LECTURE"
  | "INTERVIEW"
  | "PROJECT"
  | "ONE_ON_ONE";

/** Order and labels of the mode picker in the web page and the popup. */
export const MEETING_MODES: { value: MeetingMode; label: string }[] = [
  { value: "AUTO", label: "Auto" },
  { value: "GENERAL", label: "General" },
  { value: "LECTURE", label: "Lecture" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "PROJECT", label: "Project" },
  { value: "ONE_ON_ONE", label: "1:1" },
];

/** Contract limits for hints (backend/src/types/capture.ts LIMITS). */
export const HINT_LIMITS = { count: 20, length: 500 } as const;

/**
 * "Names and terms" box -> contract hints: split on commas and new
 * lines, trimmed, de-duplicated (case-insensitive) and capped to the
 * contract limits so the session request never fails on them.
 */
export const parseHints = (text: string): string[] => {
  const seen = new Set<string>();
  const hints: string[] = [];

  for (const raw of text.split(/[\n,]/)) {
    const hint = raw.trim().slice(0, HINT_LIMITS.length);
    const key = hint.toLowerCase();

    if (!hint || seen.has(key)) continue;

    seen.add(key);
    hints.push(hint);

    if (hints.length === HINT_LIMITS.count) break;
  }

  return hints;
};

/** First MediaRecorder type the browser supports, preferring the contract format. */
export const pickChunkMimeType = (
  isTypeSupported: (type: string) => boolean
): string => {
  const candidates = [
    CHUNK_FORMAT.mimeType,
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  return candidates.find((type) => isTypeSupported(type)) ?? "";
};

/** File extension for a recorded type: ffmpeg infers the container from it. */
export const extensionForMime = (mimeType: string): string => {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";

  return CHUNK_FORMAT.fileExtension;
};

/** One recorded chunk, as kept in the upload queue. */
export interface QueuedChunk {
  /** `${sessionId}:${seq}`: the server is idempotent on that pair too. */
  id: string;
  sessionId: string;
  seq: number;
  startOffsetMs: number;
  durationMs: number;
  channelLayout: ChannelLayout;
  mimeType: string;
  blob: Blob;
  createdAt: number;
  attempts: number;
  /** Epoch ms before which the chunk is not retried (backoff). */
  nextAttemptAt: number;
  /** Set on a 4xx the server will reject again unchanged; never retried. */
  failed?: string;
}

export const chunkId = (sessionId: string, seq: number): string =>
  `${sessionId}:${seq}`;

export interface ChunkSegment {
  idx: number;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** `data` of a 200 from POST /chunks. */
export interface ChunkResponse {
  sessionId: string;
  meetingId: string;
  seq?: number;
  elapsedMs: number;
  chunkCount: number;
  segments: ChunkSegment[];
  rollingSummaryGenerated: boolean;
  duplicate?: boolean;
}

/**
 * What the queue does with one upload attempt, per the contract table:
 * - done: 200 (first upload or `duplicate: true`): delete the chunk.
 * - retry: 409 (still processing), 5xx/502, 429, network error: keep it,
 *   back off and retry. Never a failure.
 * - halt: 401/403 (fix the token) or 410 (session ended): stop uploading.
 * - reject: any other 4xx; retrying the same request cannot succeed.
 */
export type UploadOutcome =
  | { kind: "done"; duplicate: boolean; response: ChunkResponse }
  | { kind: "retry"; status: number | null; reason: string }
  | { kind: "halt"; status: number; reason: string }
  | { kind: "reject"; status: number; reason: string };

interface Envelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

/** Maps an HTTP status and parsed body to the queue's next step. */
export const classifyChunkResponse = (
  status: number,
  body: Envelope<ChunkResponse> | null
): UploadOutcome => {
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

  if (status >= 500) return { kind: "retry", status, reason };

  if (status === 401 || status === 403) {
    return { kind: "halt", status, reason: "Device token rejected" };
  }

  if (status === 410) {
    return { kind: "halt", status, reason: "Session already ended" };
  }

  return { kind: "reject", status, reason };
};

export interface StartSessionInput {
  title: string;
  platform?: string;
  source: CaptureSource;
  mode?: MeetingMode;
  hints?: string[];
}

export interface StartedSession {
  sessionId: string;
  meetingId: string;
}

export interface CaptureClientOptions {
  /** e.g. http://localhost:5000/api (no trailing slash needed). */
  apiBase: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  /** Per chunk request: transcription may queue behind other chunks. */
  chunkTimeoutMs?: number;
}

/** Error carrying the HTTP status, so callers can tell 401 from offline. */
export class CaptureHttpError extends Error {
  status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "CaptureHttpError";
    this.status = status;
  }
}

/**
 * Thin fetch client for /api/live. fetch rather than axios so the same
 * code runs in the extension's service worker and offscreen document.
 */
export const createCaptureClient = (options: CaptureClientOptions) => {
  const base = options.apiBase.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((...args) => fetch(...args));

  const authHeaders = (): Record<string, string> =>
    options.token ? { Authorization: `Bearer ${options.token}` } : {};

  const readJson = async <T>(response: Response): Promise<Envelope<T> | null> => {
    try {
      return (await response.json()) as Envelope<T>;
    } catch {
      return null;
    }
  };

  const postJson = async <T>(path: string, body: unknown): Promise<T> => {
    let response: Response;

    try {
      response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      throw new CaptureHttpError(
        `Could not reach the backend at ${base}.`,
        null
      );
    }

    const payload = await readJson<T>(response);

    if (!response.ok || !payload?.success || payload.data === undefined) {
      throw new CaptureHttpError(
        payload?.message || `Request failed (${response.status})`,
        response.status
      );
    }

    return payload.data;
  };

  const uploadChunk = async (chunk: QueuedChunk): Promise<UploadOutcome> => {
    const form = new FormData();

    form.append(
      "audio",
      chunk.blob,
      `chunk-${chunk.seq}.${extensionForMime(chunk.mimeType)}`
    );
    form.append("seq", String(chunk.seq));
    form.append("startOffsetMs", String(Math.round(chunk.startOffsetMs)));
    form.append("durationMs", String(Math.round(chunk.durationMs)));
    form.append("channelLayout", chunk.channelLayout);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.chunkTimeoutMs ?? 5 * 60_000
    );

    try {
      const response = await doFetch(
        `${base}/live/sessions/${encodeURIComponent(chunk.sessionId)}/chunks`,
        {
          method: "POST",
          headers: authHeaders(),
          body: form,
          signal: controller.signal,
        }
      );

      return classifyChunkResponse(
        response.status,
        await readJson<ChunkResponse>(response)
      );
    } catch {
      // Offline, DNS, CORS or our own timeout: the chunk may or may
      // not have arrived; the server's idempotency makes a retry safe.
      return { kind: "retry", status: null, reason: "Network error" };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    apiBase: base,

    startSession: (input: StartSessionInput) =>
      postJson<StartedSession>("/live/sessions", input),

    uploadChunk,

    sendRoster: (sessionId: string, participants: string[]) =>
      postJson<{ sessionId: string; roster: string[] }>(
        `/live/sessions/${encodeURIComponent(sessionId)}/roster`,
        { participants }
      ),

    endSession: (sessionId: string) =>
      postJson<unknown>(
        `/live/sessions/${encodeURIComponent(sessionId)}/end`,
        {}
      ),
  };
};

export type CaptureClient = ReturnType<typeof createCaptureClient>;
