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

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProduction: process.env.NODE_ENV === "production",

  port: asNumber("PORT", 5000),

  databaseUrl: required("DATABASE_URL"),

  geminiApiKey: required("GEMINI_API_KEY"),
  geminiModel: optional("GEMINI_MODEL", "gemini-flash-latest"),

  aiServiceUrl: optional("AI_SERVICE_URL", "http://localhost:8000"),

  corsOrigin: optional("CORS_ORIGIN", "*"),

  uploadDir: optional("UPLOAD_DIR", "uploads/meetings"),
  maxUploadBytes: asNumber("MAX_UPLOAD_MB", 500) * 1024 * 1024,

  transcriptionTimeoutMs:
    asNumber("TRANSCRIPTION_TIMEOUT_MINUTES", 15) * 60 * 1000,
} as const;

export type Env = typeof env;
