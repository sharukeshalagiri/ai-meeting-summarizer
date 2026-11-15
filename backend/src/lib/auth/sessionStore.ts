import type { Prisma } from "@prisma/client";
import session from "express-session";
import * as sessionRepo from "../../repositories/session.repository";
import { logger } from "../logger";

const log = logger.child({ module: "sessionStore" });

/** Used when a session's cookie carries no expiry (it always should). */
const FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

const expiryOf = (data: session.SessionData): Date => {
  const expires = data.cookie?.expires;
  return expires ? new Date(expires) : new Date(Date.now() + FALLBACK_TTL_MS);
};

/** passport keeps the logged-in user's id at session.passport.user. */
const userIdOf = (data: session.SessionData): string | null => {
  const user = (data as { passport?: { user?: unknown } }).passport?.user;
  return typeof user === "string" ? user : null;
};

/**
 * express-session store backed by the Prisma `Session` table.
 *
 * Server-side sessions rather than a self-contained signed cookie, so
 * signing out (or changing the password) takes effect at once: the row
 * is deleted and the cookie no longer maps to anything. The table also
 * records the userId, which lets a password change end every other
 * session. Expired rows are treated as missing on read and swept on an
 * interval.
 */
export class PrismaSessionStore extends session.Store {
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: { sweepEveryMs?: number } = {}) {
    super();

    const every = options.sweepEveryMs ?? 60 * 60 * 1000;
    if (every > 0) {
      this.sweeper = setInterval(() => {
        void sessionRepo.deleteExpired().catch((error) => {
          log.warn("Expired session sweep failed", { reason: String(error) });
        });
      }, every);
      this.sweeper.unref();
    }
  }

  override get(
    sid: string,
    callback: (err: unknown, session?: session.SessionData | null) => void
  ): void {
    sessionRepo
      .find(sid)
      .then((row) => {
        if (!row || row.expiresAt.getTime() <= Date.now()) {
          return callback(null, null);
        }
        callback(null, row.data as unknown as session.SessionData);
      })
      .catch((error) => callback(error));
  }

  override set(
    sid: string,
    data: session.SessionData,
    callback?: (err?: unknown) => void
  ): void {
    sessionRepo
      .upsert(
        sid,
        JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue,
        expiryOf(data),
        userIdOf(data)
      )
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  override destroy(sid: string, callback?: (err?: unknown) => void): void {
    sessionRepo
      .destroy(sid)
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  override touch(
    sid: string,
    data: session.SessionData,
    callback?: (err?: unknown) => void
  ): void {
    sessionRepo
      .touch(sid, expiryOf(data))
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
