import type { NextFunction, Request, Response } from "express";
import passport from "passport";
import { resolveUser, type AuthUser } from "../lib/auth/currentUser";
import { SESSION_COOKIE } from "../lib/auth/session";
import { env } from "../lib/env";
import { currentUser } from "../middleware/auth.middleware";
import { getAccount } from "../services/account/account.service";
import * as authService from "../services/auth/auth.service";
import { MAX_PASSWORD_LENGTH } from "../lib/auth/password";
import { sendSuccess } from "../types/api";
import { AppError, BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import { requireString } from "../utils/validate";

/** Passwords are not trimmed: spaces are legal characters in them. */
const requirePassword = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value) throw BadRequest(`${field} is required`);
  if (value.length > MAX_PASSWORD_LENGTH) throw BadRequest(`${field} is too long`);
  return value;
};

/** req.logIn as a promise; passport regenerates the session first. */
const logIn = (req: Request, user: AuthUser) =>
  new Promise<void>((resolve, reject) => req.logIn(user, (error) => (error ? reject(error) : resolve())));

/**
 * POST /auth/login { email, password }: passport's local strategy, then
 * a fresh session. Every failure is the same 401 message.
 */
export const login = (req: Request, res: Response, next: NextFunction) => {
  try {
    requireString(req.body?.email, "email", { maxLength: 200 });
    requirePassword(req.body?.password, "password");
  } catch (error) {
    return next(error);
  }

  passport.authenticate("local", { session: false }, (error: unknown, user: AuthUser | false) => {
    if (error) return next(error);
    if (!user) return next(new AppError(authService.INVALID_LOGIN, 401));

    logIn(req, user)
      .then(() => sendSuccess(res, user, "Signed in"))
      .catch(next);
  })(req, res, next);
};

export const logout = (req: Request, res: Response, next: NextFunction) => {
  req.logout((error) => {
    if (error) return next(error);

    // logout() keeps a (now anonymous) session; remove it entirely.
    const done = () => {
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: env.isProduction });
      sendSuccess(res, { signedOut: true }, "Signed out");
    };

    if (req.session) req.session.destroy(() => done());
    else done();
  });
};

/**
 * GET /auth/me: the signed-in user with their settings, or 401. Also
 * says whether sign-up is open, so the login page can offer it.
 */
export const me = asyncHandler(async (req: Request, res: Response) => {
  const user = resolveUser(req);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Please sign in.",
      data: { signupEnabled: env.authAllowSignup },
    });
  }

  return sendSuccess(res, await getAccount(user.id), "Signed in");
});

export const signup = asyncHandler(async (req: Request, res: Response) => {
  const user = await authService.signUp({
    name: requireString(req.body?.name, "name", { maxLength: 120 }),
    email: requireString(req.body?.email, "email", { maxLength: 200 }),
    password: requirePassword(req.body?.password, "password"),
  });

  await logIn(req, user);

  return sendSuccess(res, user, "Account created", 201);
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.changePassword({
    userId: currentUser(req).id,
    currentPassword: requirePassword(req.body?.currentPassword, "currentPassword"),
    newPassword: requirePassword(req.body?.newPassword, "newPassword"),
    sessionId: req.sessionID,
  });

  return sendSuccess(res, result, "Password changed; other sessions were signed out");
});
