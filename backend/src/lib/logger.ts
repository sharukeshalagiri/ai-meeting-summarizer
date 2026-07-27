/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free: it emits one JSON object per line, so
 * a hosted log collector can parse it, while staying readable in a
 * terminal during development. Swapping in pino later only requires
 * changing this file.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (): LogLevel => {
  const raw = process.env.LOG_LEVEL?.toLowerCase();

  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }

  return process.env.NODE_ENV === "production" ? "info" : "debug";
};

/** Extra fields attached to a log line. */
export type LogContext = Record<string, unknown>;

/** Keys whose values must never reach the logs. */
const REDACTED_KEYS = [
  "password",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "databaseurl",
  "database_url",
];

const redact = (context: LogContext): LogContext => {
  const safe: LogContext = {};

  for (const [key, value] of Object.entries(context)) {
    safe[key] = REDACTED_KEYS.includes(key.toLowerCase())
      ? "[redacted]"
      : value;
  }

  return safe;
};

/**
 * Errors do not serialize with JSON.stringify, so pull the useful
 * fields out explicitly. The stack is kept for server-side diagnosis.
 */
const serializeError = (error: unknown): LogContext => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(typeof (error as { status?: number }).status === "number"
        ? { errorStatus: (error as { status?: number }).status }
        : {}),
      stack: error.stack,
    };
  }

  return { error: String(error) };
};

const write = (
  level: LogLevel,
  message: string,
  context?: LogContext
): void => {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) {
    return;
  }

  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context ? redact(context) : {}),
  };

  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: unknown, context?: LogContext): void;
  /** Returns a logger that stamps every line with the given fields. */
  child(bindings: LogContext): Logger;
}

const build = (bindings: LogContext): Logger => ({
  debug: (message, context) =>
    write("debug", message, { ...bindings, ...context }),

  info: (message, context) =>
    write("info", message, { ...bindings, ...context }),

  warn: (message, context) =>
    write("warn", message, { ...bindings, ...context }),

  error: (message, error, context) =>
    write("error", message, {
      ...bindings,
      ...context,
      ...(error === undefined ? {} : serializeError(error)),
    }),

  child: (extra) => build({ ...bindings, ...extra }),
});

export const logger = build({});
