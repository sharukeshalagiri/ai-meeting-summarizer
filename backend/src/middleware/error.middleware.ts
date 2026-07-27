import { Request, Response, NextFunction } from "express";
import { sendError } from "../types/api";
import { toUserMessage } from "../types/errors";

/** Unmatched /api routes should return JSON, not Express's HTML page. */
export const notFoundHandler = (_req: Request, res: Response) =>
  sendError(res, "Route not found", 404);

/**
 * Single exit point for every failure: maps known errors (Prisma,
 * AppError) to a user-friendly message and the right status.
 */
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const appError = toUserMessage(err);

  // Log the original for debugging; the client sees only the message.
  console.error(err);

  return sendError(res, appError.message, appError.status);
};
