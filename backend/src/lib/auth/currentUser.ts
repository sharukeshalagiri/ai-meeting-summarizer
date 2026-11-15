import type { Request } from "express";

/**
 * The signed-in user as every controller sees it. passport sets
 * `req.user` from the session cookie; device auth sets it from a
 * recorder's Bearer token. Nothing else is ever read for identity.
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  /** Set when the request was authenticated by a device token. */
  deviceTokenId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // Merged with passport's empty Express.User.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthUser {}
  }
}

/**
 * Who is making this request, or null. The one seam the test setup
 * (test/setup.auth.ts) replaces, so route tests written before accounts
 * run as a default user without a database.
 */
export const resolveUser = (req: Request): AuthUser | null =>
  req.user && typeof req.user.id === "string" ? req.user : null;
