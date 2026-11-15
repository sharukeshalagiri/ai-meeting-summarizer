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
 * DEPRECATED (w4-acct): the shared recorder secret. Recorders now send a
 * per-user device token (Devices page), and this value is ignored. Kept
 * only so an existing .env still loads; it is no longer required in
 * production.
 */
const deviceToken = (): string | null =>
  process.env.DEVICE_TOKEN?.trim() || null;

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

/**
 * Where background jobs run (w3-jobs): "pgboss" (durable, in Postgres;
 * the default) or "memory" (in-process, lost on restart). Tests always
 * use "memory" so they never need a database.
 */
const jobsDriver = (): "pgboss" | "memory" => {
  if (process.env.NODE_ENV === "test") return "memory";

  const value = optional("JOBS_DRIVER", "pgboss").trim().toLowerCase();

  if (value !== "pgboss" && value !== "memory") {
    throw new Error(`JOBS_DRIVER must be "pgboss" or "memory", got "${value}".`);
  }

  return value;
};

/** Storage driver for recordings and job artifacts. Only "local" exists. */
const storageDriver = (): "local" => {
  const value = optional("STORAGE_DRIVER", "local").trim().toLowerCase();

  if (value !== "local") {
    throw new Error(`STORAGE_DRIVER must be "local", got "${value}".`);
  }

  return value;
};

/**
 * Speaker diarization (w2-spk): voice (ai-service speaker embeddings,
 * default), text (Gemini infers turns), or deepgram (paid per minute,
 * needs DEEPGRAM_API_KEY). Voice falls back to text when unavailable.
 */
const diarizationProvider = (): "voice" | "text" | "deepgram" => {
  const value = optional("DIARIZATION_PROVIDER", "voice").trim().toLowerCase();

  if (value !== "voice" && value !== "text" && value !== "deepgram") {
    throw new Error(
      `DIARIZATION_PROVIDER must be "voice", "text" or "deepgram", got "${value}".`
    );
  }

  if (value === "deepgram" && !process.env.DEEPGRAM_API_KEY?.trim()) {
    throw new Error(
      "Missing required environment variable: DEEPGRAM_API_KEY. " +
        "It is required when DIARIZATION_PROVIDER=deepgram."
    );
  }

  return value;
};

/**
 * Signs the session cookie (w4-acct). Required in production; in
 * development a fixed placeholder keeps sessions across ts-node-dev
 * restarts, with a warning at boot (lib/auth/session.ts).
 */
const sessionSecret = (): string | null => {
  const value = process.env.SESSION_SECRET?.trim();

  if (value) {
    if (isProduction && value.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters in production.");
    }
    return value;
  }

  if (isProduction) {
    throw new Error(
      "Missing required environment variable: SESSION_SECRET. " +
        "It is required when NODE_ENV=production (openssl rand -hex 32)."
    );
  }

  return null;
};

const asBoolean = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Environment variable ${name} must be true or false, got "${raw}".`);
};

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProduction,

  port: asNumber("PORT", 5000),

  databaseUrl: required("DATABASE_URL"),

  geminiApiKey: required("GEMINI_API_KEY"),
  geminiModel: optional("GEMINI_MODEL", "gemini-flash-latest"),
  /**
   * Cheap model for the summary pipeline's high-volume passes (CLEAN
   * labels every segment; CLASSIFY reads the opening minutes). Quality
   * matters less there than cost and latency.
   */
  geminiCleanModel: optional("GEMINI_CLEAN_MODEL", "gemini-flash-lite-latest"),
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

  /** See jobsDriver() above (w3-jobs). */
  jobsDriver: jobsDriver(),
  /** See storageDriver() above. */
  storageDriver: storageDriver(),
  /** Root of local storage (recordings, job artifacts), relative to backend/. */
  storageDir: optional("STORAGE_DIR", "uploads"),
  /** See diarizationProvider() above. */
  diarizationProvider: diarizationProvider(),
  /** Label for the user's own (mic channel) segments until renamed. */
  meDisplayName: optional("ME_DISPLAY_NAME", "You").trim().slice(0, 60) || "You",

  /** See sessionSecret() above (w4-acct). Null = development placeholder. */
  sessionSecret: sessionSecret(),
  /** Days a login lasts without activity (the cookie is rolling). */
  sessionMaxAgeDays: asNumber("SESSION_MAX_AGE_DAYS", 30),
  /**
   * POST /api/auth/signup. On outside production, off in production,
   * where `npm --prefix backend run user:password` creates the account.
   */
  authAllowSignup: asBoolean("AUTH_ALLOW_SIGNUP", !isProduction),
  /** SMTP for "email this summary" (w4-acct). Unset host = email export off. */
  smtpHost: process.env.SMTP_HOST?.trim() || null,
  smtpPort: asNumber("SMTP_PORT", 587),
  /** true = TLS from the start (port 465); false = STARTTLS. */
  smtpSecure: asBoolean("SMTP_SECURE", false),
  smtpUser: process.env.SMTP_USER?.trim() || null,
  smtpPassword: process.env.SMTP_PASSWORD || null,
  smtpFrom: optional("SMTP_FROM", "Meeting Companion <no-reply@localhost>"),
  /** How often the audio-retention job runs (cron, UTC). Hourly by default. */
  retentionCron: optional("RETENTION_CRON", "17 * * * *"),
  /** ffmpeg binary for live assembly (w3-jobs); on PATH by default. */
  ffmpegPath: optional("FFMPEG_PATH", "ffmpeg"),
} as const;

export type Env = typeof env;
