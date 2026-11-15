import { env } from "../../lib/env";
import type { AuthUser } from "../../lib/auth/currentUser";
import {
  burnVerify,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from "../../lib/auth/password";
import { logger } from "../../lib/logger";
import * as sessionRepo from "../../repositories/session.repository";
import * as userRepo from "../../repositories/user.repository";
import { AppError, BadRequest } from "../../types/errors";
import { loginThrottle, type Throttle } from "./throttle";

const log = logger.child({ module: "auth.service" });

/**
 * Email + password accounts. passport (lib/auth/passport.ts) calls
 * verifyCredentials; the routes call the rest. No Express here.
 */

/** One message for every sign-in failure, so it reveals nothing. */
export const INVALID_LOGIN = "Wrong email or password.";

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const assertEmail = (email: string): string => {
  const normalized = normalizeEmail(email);
  if (!EMAIL.test(normalized) || normalized.length > 200) {
    throw BadRequest("Enter a valid email address.");
  }
  return normalized;
};

const assertPassword = (password: string) => {
  const problem = passwordProblem(password);
  if (problem) throw BadRequest(problem);
};

const tooMany = (seconds: number) =>
  new AppError(
    `Too many sign-in attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
    429
  );

/**
 * Checks an email and password. Null when they do not match (passport
 * turns that into a 401); throws 429 when throttled. The same work is
 * done for unknown emails and for users without a password, so timing
 * does not reveal which emails have accounts.
 */
export const verifyCredentials = async (
  email: string,
  password: string,
  client: string,
  throttle: Throttle = loginThrottle
): Promise<AuthUser | null> => {
  const normalized = normalizeEmail(email);
  const keys = [`email:${normalized}`, `ip:${client}`];

  const wait = Math.max(...keys.map((key) => throttle.retryAfter(key)));
  if (wait > 0) throw tooMany(wait);

  const user = normalized ? await userRepo.findCredentialsByEmail(normalized) : null;

  const ok = user?.passwordHash
    ? await verifyPassword(user.passwordHash, password)
    : (await burnVerify(password), false);

  if (!ok || !user) {
    keys.forEach((key) => throttle.fail(key));
    log.info("Sign-in failed", { known: Boolean(user) });
    return null;
  }

  throttle.clear(keys[0]);
  log.info("Signed in", { userId: user.id });

  return { id: user.id, name: user.name, email: user.email };
};

/** Self-service sign-up (AUTH_ALLOW_SIGNUP). */
export const signUp = async (input: {
  name: string;
  email: string;
  password: string;
}): Promise<AuthUser> => {
  if (!env.authAllowSignup) {
    throw new AppError("Sign-up is turned off on this server.", 403);
  }

  const email = assertEmail(input.email);
  assertPassword(input.password);

  if (await userRepo.findByEmail(email)) {
    throw new AppError("An account with that email already exists.", 409);
  }

  const user = await userRepo.create({
    name: input.name.trim().slice(0, 120) || email,
    email,
    passwordHash: await hashPassword(input.password),
  });

  log.info("User signed up", { userId: user.id });

  return { id: user.id, name: user.name, email: user.email };
};

/**
 * Changes the signed-in user's password and signs out every other
 * session (a stolen cookie stops working).
 */
export const changePassword = async (input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  sessionId?: string;
}) => {
  const stored = await userRepo.findPasswordHash(input.userId);

  if (!stored || !(await verifyPassword(stored, input.currentPassword))) {
    throw BadRequest("Your current password is not correct.");
  }

  assertPassword(input.newPassword);

  await userRepo.setPasswordHash(input.userId, await hashPassword(input.newPassword));
  const ended = await sessionRepo.destroyForUser(input.userId, input.sessionId);

  log.info("Password changed", { userId: input.userId, otherSessionsEnded: ended.count });

  return { changed: true };
};

/**
 * CLI (scripts/set-password.ts): sets a password for an existing user,
 * or creates the user when `createName` is given. Ends that user's
 * sessions.
 */
export const setPasswordFor = async (input: {
  email: string;
  password: string;
  createName?: string;
}) => {
  const email = assertEmail(input.email);
  assertPassword(input.password);
  const passwordHash = await hashPassword(input.password);

  const existing = await userRepo.findByEmail(email);

  if (!existing) {
    if (!input.createName) {
      throw BadRequest(`No user with email ${email}. Pass --name to create one.`);
    }
    const user = await userRepo.create({ name: input.createName, email, passwordHash });
    return { userId: user.id, created: true };
  }

  await userRepo.setPasswordHash(existing.id, passwordHash);
  await sessionRepo.destroyForUser(existing.id);

  return { userId: existing.id, created: false };
};
