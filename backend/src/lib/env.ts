import dotenv from "dotenv";

// Loaded here, at the top of the import graph, so every module that
// reads configuration sees a populated process.env regardless of
// import order.
dotenv.config();

/**
 * Configuration is read once and validated at startup, so a missing
 * value fails fast on boot instead of surfacing as a confusing error
 * on the first request that happens to need it.
 */

const required = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Add it to backend/.env (see .env.example).`
    );
  }

  return value;
};

const optional = (name: string, fallback: string): string =>
  process.env[name] || fallback;

const asNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];

  if (!raw) return fallback;

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Environment variable ${name} must be a number, got "${raw}".`
    );
  }

  return parsed;
};

const isProduction = process.env.NODE_ENV === "production";

/**
 * Shared secret recorders (extension, desktop app, bot) send as
 * `Authorization: Bearer <token>` on /api/live. Optional in development
 * so the web page works without setup; production refuses to boot
 * without it. See middleware/deviceAuth.middleware.ts.
 */
const deviceToken = (): string | null => {
  const value = process.env.DEVICE_TOKEN?.trim();

  if (value) return value;

  if (isProduction) {
    throw new Error(
      "Missing required environment variable: DEVICE_TOKEN. " +
        "It is required when NODE_ENV=production."
    );
  }

  return null;
};

/**
 * Which TranscriptionProvider speech.service uses (w1-asr):
 * "local" = the ai-service (faster-whisper, free, default);
 * "deepgram" = Deepgram's hosted API, which is PAID per audio minute and
 * needs DEEPGRAM_API_KEY. Validated here so a typo fails at boot.
 */
const transcriptionProvider = (): "local" | "deepgram" => {
  const value = optional("TRANSCRIPTION_PROVIDER", "local").trim().toLowerCase();

  if (value !== "local" && value !== "deepgram") {
    throw new Error(
      `TRANSCRIPTION_PROVIDER must be "local" or "deepgram", got "${value}".`
    );
  }

  if (value === "deepgram" && !process.env.DEEPGRAM_API_KEY?.trim()) {
    throw new Error(
      "Missing required environment variable: DEEPGRAM_API_KEY. " +
        "It is required when TRANSCRIPTION_PROVIDER=deepgram."
    );
  }

  return value;
};

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProduction,

  port: asNumber("PORT", 5000),

  databaseUrl: required("DATABASE_URL"),

  geminiApiKey: required("GEMINI_API_KEY"),
  geminiModel: optional("GEMINI_MODEL", "gemini-flash-latest"),
  embeddingModel: optional("EMBEDDING_MODEL", "gemini-embedding-2"),
  /**
   * Truncated embedding width. 768 keeps storage and the similarity
   * scan cheap while retaining retrieval quality; the full 3072 is
   * overkill for transcript segments.
   */
  embeddingDims: asNumber("EMBEDDING_DIMS", 768),

  aiServiceUrl: optional("AI_SERVICE_URL", "http://localhost:8000"),

  corsOrigin: optional("CORS_ORIGIN", "*"),

  uploadDir: optional("UPLOAD_DIR", "uploads/meetings"),
  /** Live capture chunks, deleted once transcribed. */
  liveChunkDir: optional("LIVE_CHUNK_DIR", "uploads/live"),
  maxUploadBytes: asNumber("MAX_UPLOAD_MB", 500) * 1024 * 1024,
  /** One chunk of captured audio; far smaller than a full recording. */
  maxChunkBytes: asNumber("MAX_CHUNK_MB", 25) * 1024 * 1024,

  transcriptionTimeoutMs:
    asNumber("TRANSCRIPTION_TIMEOUT_MINUTES", 15) * 60 * 1000,

  /**
   * How much captured audio to accumulate between rolling summaries.
   * The brief calls for 5-10 minutes; 7 sits in the middle and keeps
   * Gemini calls well inside the free tier on a long meeting.
   */
  rollingSummaryEveryMs:
    asNumber("ROLLING_SUMMARY_MINUTES", 7) * 60 * 1000,

  /**
   * Silence after which a live session is assumed abandoned. Chunks
   * arrive far more often than this, so it only triggers when the tab
   * is gone.
   */
  liveSessionIdleMs: asNumber("LIVE_SESSION_IDLE_MINUTES", 10) * 60 * 1000,

  /** Null means device auth is off (development only). */
  deviceToken: deviceToken(),

  /** See transcriptionProvider() above. */
  transcriptionProvider: transcriptionProvider(),
  /** Only read when TRANSCRIPTION_PROVIDER=deepgram. */
  deepgramApiKey: process.env.DEEPGRAM_API_KEY?.trim() || null,
  /** nova-2 takes `keywords`; nova-3 models take `keyterm` instead. */
  deepgramModel: optional("DEEPGRAM_MODEL", "nova-2"),
} as const;

export type Env = typeof env;
