import type { RequestHandler } from "express";
import session from "express-session";
import { env } from "../env";
import { logger } from "../logger";
import { configurePassport } from "./passport";
import { PrismaSessionStore } from "./sessionStore";

const log = logger.child({ module: "auth.session" });

export const SESSION_COOKIE = "ams.sid";

const DEV_SECRET = "development-only-session-secret-do-not-use-in-production";

let store: PrismaSessionStore | null = null;

/**
 * The session cookie:
 * - httpOnly, so page scripts (and an XSS) cannot read it;
 * - SameSite=Lax, so other sites cannot send it with a POST (CSRF);
 *   the dev frontend on another localhost port is the same site, so it
 *   still works there;
 * - Secure in production; `proxy` trusts X-Forwarded-Proto from Caddy,
 *   which terminates TLS, without changing app-wide `trust proxy`;
 * - rolling: every response pushes the expiry SESSION_MAX_AGE_DAYS out.
 * saveUninitialized is off, so no row (and no cookie) exists until a
 * login, and anonymous requests never touch the store.
 */
export const authMiddleware = (): RequestHandler[] => {
  if (!env.sessionSecret) {
    log.warn(
      "SESSION_SECRET is not set: using a development placeholder. " +
        "Set it before exposing the backend."
    );
  }

  store ??= new PrismaSessionStore({
    sweepEveryMs: env.nodeEnv === "test" ? 0 : undefined,
  });

  const passport = configurePassport();

  return [
    session({
      name: SESSION_COOKIE,
      secret: env.sessionSecret ?? DEV_SECRET,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: env.isProduction,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: env.isProduction,
        maxAge: env.sessionMaxAgeDays * 24 * 60 * 60 * 1000,
      },
    }),
    passport.initialize(),
    passport.session(),
  ];
};
