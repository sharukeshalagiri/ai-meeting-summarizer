import type { NextFunction, Request, Response } from "express";
import { resolveUser, type AuthUser } from "../lib/auth/currentUser";
import { env } from "../lib/env";
import { isDemoUser } from "../middleware/demo.middleware";
import * as demoService from "../services/w5-demo.service";
import { sendSuccess } from "../types/api";
import { asyncHandler } from "../utils/asyncHandler";
import { optionalString, requireString } from "../utils/validate";

/** GET /api/demo: whether the sign-in page should offer the demo. */
export const getDemo = asyncHandler(async (_req: Request, res: Response) =>
  sendSuccess(res, demoService.demoStatus(), "Demo status")
);

const logIn = (req: Request, user: AuthUser) =>
  new Promise<void>((resolve, reject) => req.logIn(user, (error) => (error ? reject(error) : resolve())));

const saveSession = (req: Request) =>
  new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));

/**
 * POST /api/demo/login: signs the visitor into the demo account, no
 * password. passport regenerates the session first (no fixation). The
 * session lasts DEMO_SESSION_HOURS instead of the usual 30 days; saving
 * it again stores the shorter max age, so the rolling cookie keeps it.
 */
export const demoLogin = asyncHandler(async (req: Request, res: Response) => {
  const { user, meetingId } = await demoService.demoAccount();

  await logIn(req, user);
  req.session.cookie.maxAge = env.demoSessionHours * 60 * 60 * 1000;
  await saveSession(req);

  return sendSuccess(res, { user, meetingId }, "Signed in to the demo");
});

/**
 * GET /api/search for the demo account only: a keyword search over its
 * meetings, because semantic search would call Gemini. Anyone else falls
 * through to the real search.
 */
export const demoSearch = async (req: Request, res: Response, next: NextFunction) => {
  const user = resolveUser(req);
  if (!user || !isDemoUser(user)) return next();

  try {
    const limit = Number(req.query.limit);
    const results = await demoService.keywordSearch({
      userId: user.id,
      query: requireString(req.query.q, "q", { maxLength: 500 }),
      meetingId: optionalString(req.query.meetingId),
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return sendSuccess(res, results, "Search complete");
  } catch (error) {
    return next(error);
  }
};
