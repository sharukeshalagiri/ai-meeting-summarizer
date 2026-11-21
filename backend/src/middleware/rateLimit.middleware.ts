import { execFile } from "child_process";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import path from "path";
import { promisify } from "util";
import * as limitsRepo from "../demo/limits.repository";
import { resolveUser } from "../lib/auth/currentUser";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { AppError, BadRequest } from "../types/errors";

const log = logger.child({ module: "rateLimit.middleware" });

/**
 * Public-instance safety: rate limits on /api and caps on how
 * much audio one request can make the server process.
 *
 * In memory, per process: the app runs as one backend container, and a
 * restart forgetting the counters only ever lets a client in early. A
 * fixed window is enough here; the point is to stop a script, not to
 * shape traffic precisely.
 */

/* ---------- rate limits ---------- */

/**
 * Requests that cost real resources (Whisper, Gemini, disk, email, a
 * password hash), relative to /api. They share a smaller hourly budget
 * on top of the per-minute one.
 */
const HEAVY: RegExp[] = [
  /^\/meetings\/[^/]+\/(audio|upload|transcribe|summarize|resummarize|process|retry|index|export\/email)\/?$/i,
  /^\/chat\/?$/i,
  /^\/live\/sessions\/?$/i,
  /^\/demo\/login\/?$/i,
  /^\/auth\/(login|signup)\/?$/i,
];

export const isHeavy = (method: string, apiPath: string): boolean =>
  method === "POST" && HEAVY.some((pattern) => pattern.test(apiPath));

const isPrivateAddress = (ip: string): boolean => {
  const v4 = ip.replace(/^::ffff:/i, "");
  return (
    ip === "::1" ||
    /^127\./.test(v4) ||
    /^10\./.test(v4) ||
    /^192\.168\./.test(v4) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip)
  );
};

/**
 * Who a request counts against: the signed-in user, else the client IP.
 * Behind the deploy's reverse proxy (Caddy, on a private address) the
 * socket peer is the proxy, so the last X-Forwarded-For entry, the one
 * the proxy appended, is the client. A client talking to the backend
 * directly from the internet is never a private address, so it cannot
 * pick its own key with a forged header.
 */
export const clientKey = (req: Request): string => {
  const user = resolveUser(req);
  if (user) return `user:${user.id}`;

  const peer = req.socket?.remoteAddress ?? "unknown";
  const forwarded = req.header("x-forwarded-for");
  if (forwarded && isPrivateAddress(peer)) {
    const last = forwarded.split(",").map((part) => part.trim()).filter(Boolean).pop();
    if (last) return `ip:${last}`;
  }
  return `ip:${peer}`;
};

export class FixedWindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** Counts one request; returns the seconds to wait when over the limit. */
  take(key: string, now: number): { allowed: true } | { allowed: false; retryAfterSec: number } {
    if (this.hits.size > 10_000) this.sweep(now);

    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }

    entry.count += 1;
    if (entry.count <= this.limit) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

export interface RateLimitOptions {
  enabled: boolean;
  perMinute: number;
  heavyPerHour: number;
  now?: () => number;
}

export const createRateLimit = (options: RateLimitOptions): RequestHandler => {
  const now = options.now ?? Date.now;
  const general = new FixedWindowCounter(options.perMinute, 60_000);
  const heavy = new FixedWindowCounter(options.heavyPerHour, 60 * 60_000);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!options.enabled || req.method === "OPTIONS") return next();

    const key = clientKey(req);
    const at = now();
    const checks = [general.take(key, at)];
    if (isHeavy(req.method, req.path)) checks.push(heavy.take(key, at));

    const refused = checks.find((check) => !check.allowed);
    if (!refused || refused.allowed) return next();

    res.setHeader("Retry-After", String(refused.retryAfterSec));
    log.info("Rate limited", { key: key.startsWith("user:") ? "user" : "ip", path: req.path });
    return next(new AppError("Too many requests. Please wait a moment and try again.", 429));
  };
};

/** Mounted in routes/index.ts after the session is read (keys by user). */
export const rateLimit = createRateLimit({
  enabled: env.rateLimitEnabled,
  perMinute: env.rateLimitPerMinute,
  heavyPerHour: env.rateLimitHeavyPerHour,
});

/* ---------- duration caps ---------- */

const runFile = promisify(execFile);

/** Seconds of audio in a file, via ffprobe. */
export const probeDurationSec = async (file: string, ffprobe = env.ffprobePath): Promise<number> => {
  const { stdout } = await runFile(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { timeout: 30_000, windowsHide: true }
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error("ffprobe returned no duration");
  return seconds;
};

export interface DurationCapOptions {
  maxMinutes: number;
  probe?: (file: string) => Promise<number>;
  audioPathOf?: (meetingId: string) => Promise<string | null>;
  elapsedMsOf?: (sessionId: string) => Promise<number | null>;
}

const tooLong = (maxMinutes: number, what: string) =>
  new AppError(`${what} is longer than this server's ${maxMinutes}-minute limit.`, 413);

/**
 * MAX_AUDIO_MINUTES (0 = off). The upload size cap is MAX_UPLOAD_MB
 * (multer); this one bounds the work: Whisper time grows with duration,
 * not with file size, and a small, low-bitrate file can hold hours.
 *
 * - `recording`: before /transcribe, /process and /retry start work on
 *   an uploaded recording, its duration is measured with ffprobe. If
 *   ffprobe is missing or fails, the request goes on (logged): the
 *   transcription timeout still bounds it.
 * - `live`: a chunk for a session that already captured the limit is
 *   refused (413), so a recorder left running stops costing work.
 * - `singleRequestUpload`: POST /:id/upload stores and transcribes in
 *   one request, so there is no point to measure the file before work
 *   starts. While a cap is set it is refused, with a pointer to the
 *   staged flow the web app uses (/audio, then /process).
 */
export const createDurationCaps = (options: DurationCapOptions) => {
  const max = options.maxMinutes;
  const probe = options.probe ?? ((file: string) => probeDurationSec(file));
  const audioPathOf = options.audioPathOf ?? limitsRepo.meetingAudioPath;
  const elapsedMsOf = options.elapsedMsOf ?? limitsRepo.liveSessionElapsedMs;

  const recording: RequestHandler = (req, _res, next) => {
    const meetingId = req.params.id;
    if (max <= 0 || typeof meetingId !== "string") return next();

    audioPathOf(meetingId)
      .then(async (audioPath) => {
        if (!audioPath) return next();
        let seconds: number;
        try {
          seconds = await probe(path.resolve(audioPath));
        } catch (error) {
          log.warn("Could not measure the recording; MAX_AUDIO_MINUTES not applied", {
            meetingId,
            reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
          });
          return next();
        }
        return seconds > max * 60 ? next(tooLong(max, "This recording")) : next();
      })
      .catch(next);
  };

  const live: RequestHandler = (req, _res, next) => {
    const sessionId = req.params.id;
    if (max <= 0 || typeof sessionId !== "string") return next();

    elapsedMsOf(sessionId)
      .then((elapsedMs) => (elapsedMs !== null && elapsedMs >= max * 60_000 ? next(tooLong(max, "This capture")) : next()))
      .catch(next);
  };

  const singleRequestUpload: RequestHandler = (_req, _res, next) =>
    max <= 0
      ? next()
      : next(BadRequest("Upload with POST /meetings/:id/audio, then POST /meetings/:id/process, while MAX_AUDIO_MINUTES is set."));

  return { recording, live, singleRequestUpload };
};

export const durationCaps = createDurationCaps({ maxMinutes: env.maxAudioMinutes });
