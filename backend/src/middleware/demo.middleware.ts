import type { NextFunction, Request, Response } from "express";
import { resolveUser, type AuthUser } from "../lib/auth/currentUser";
import { DEMO_EMAIL } from "../demo/types";
import { AppError } from "../types/errors";

/**
 * The demo account is read-only, enforced here on the server for every
 * route, not only by hiding buttons (w5-demo).
 *
 * Mounted in routes/index.ts right after the session is read, before
 * any router, so it covers /live, /meetings, /account, /devices, every
 * track's routes and any route added later: for the demo account, every
 * method except GET, HEAD and OPTIONS is refused, apart from signing
 * out (and signing in to another account).
 *
 * That one rule covers uploads, deletes, renames, settings, device
 * tokens, email exports, re-summarizing and chat, which are all
 * POST/PUT/PATCH/DELETE. The only GET that calls Gemini is search (it
 * embeds the query); the demo answers it with a keyword search instead
 * (routes/w5-demo.routes.ts), mounted before the real one.
 */

export const DEMO_READ_ONLY_MESSAGE =
  "This is a read-only demo: uploads, edits, deletes and AI calls are turned off. Run the app locally to try them.";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** "METHOD /path" (relative to /api) the demo account may still send. */
const ALLOWED_WRITES = new Set(["POST /auth/logout", "POST /auth/login"]);

export const isDemoUser = (user: Pick<AuthUser, "email"> | null | undefined): boolean =>
  !!user && user.email.trim().toLowerCase() === DEMO_EMAIL;

/** Lower case without a trailing slash, as Express matches routes. */
const normalize = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path).toLowerCase();

export const demoReadOnly = (req: Request, _res: Response, next: NextFunction) => {
  if (!isDemoUser(resolveUser(req))) return next();
  if (SAFE_METHODS.has(req.method)) return next();
  if (ALLOWED_WRITES.has(`${req.method} ${normalize(req.path)}`)) return next();

  return next(new AppError(DEMO_READ_ONLY_MESSAGE, 403));
};
