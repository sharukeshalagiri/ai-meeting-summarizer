import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates every log line emitted while handling this request. */
      id: string;
    }
  }
}

/**
 * Assigns a request id and logs one line per completed request.
 *
 * Logging on 'finish' rather than up front means the status code and
 * duration are known, so each request produces a single useful entry
 * instead of two half-useful ones.
 */
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);

  const startedAt = Date.now();

  res.on("finish", () => {
    const context = {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    };

    if (res.statusCode >= 500) {
      logger.error("Request failed", undefined, context);
    } else if (res.statusCode >= 400) {
      logger.warn("Request rejected", context);
    } else {
      logger.info("Request completed", context);
    }
  });

  next();
};
