import type { NextFunction, Request, Response } from "express";
import { resolveUser, type AuthUser } from "../lib/auth/currentUser";
import {
  assertLiveSessionOwner,
  assertMeetingOwner,
} from "../services/account/access.service";
import { AppError } from "../types/errors";

/**
 * Session auth for the web app. Every route under /api except /auth,
 * /health and /live (which has device auth) sits behind requireUser.
 */

export const unauthenticated = () => new AppError("Please sign in.", 401);

export const requireUser = (req: Request, _res: Response, next: NextFunction) =>
  resolveUser(req) ? next() : next(unauthenticated());

/** The signed-in user; only call it behind requireUser or device auth. */
export const currentUser = (req: Request): AuthUser => {
  const user = resolveUser(req);
  if (!user) throw unauthenticated();
  return user;
};

export const currentUserId = (req: Request): string => currentUser(req).id;

/**
 * Mounted on /meetings/:id in routes/index.ts, in front of every router
 * that serves a meeting's sub-resources (meeting, w1-sum, w2-spk,
 * w3-jobs, exports, series), so a meeting of another account is a 404
 * before any of their controllers run.
 */
export const requireMeetingAccess = (req: Request, _res: Response, next: NextFunction) => {
  const meetingId = req.params.id;
  const user = resolveUser(req);

  if (!user) return next(unauthenticated());
  if (typeof meetingId !== "string" || !meetingId) return next();

  assertMeetingOwner(user.id, meetingId).then(() => next(), next);
};

/**
 * Mounted on /live/sessions/:id after device auth: a recorder can only
 * send chunks, roster and end to sessions of its own account. Runs
 * before multer, so a chunk for someone else's session is never stored.
 */
export const requireLiveSessionAccess = (req: Request, _res: Response, next: NextFunction) => {
  const sessionId = req.params.id;
  const user = resolveUser(req);

  if (!user) return next(unauthenticated());
  if (typeof sessionId !== "string" || !sessionId) return next();

  assertLiveSessionOwner(user.id, sessionId).then(() => next(), next);
};
