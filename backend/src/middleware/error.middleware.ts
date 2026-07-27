import { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";
import { sendError } from "../types/api";
import { toUserMessage } from "../types/errors";

/** Unmatched /api routes should return JSON, not Express's HTML page. */
export const notFoundHandler = (_req: Request, res: Response) =>
  sendError(res, "Route not found", 404);

/**
 * Single exit point for every failure: maps known errors (Prisma,
 * AppError) to a user-safe message and the right status code.
 *
 * Client errors (4xx) are expected and logged at warn; only 5xx
 * indicates a defect worth investigating, so it carries the stack.
 */
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  const appError = toUserMessage(err);

  const context = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    status: appError.status,
  };

  if (appError.status >= 500) {
    logger.error("Unhandled error", err, context);
  } else {
    logger.warn("Request error", {
      ...context,
      reason: appError.message,
    });
  }

  return sendError(res, appError.message, appError.status);
};
