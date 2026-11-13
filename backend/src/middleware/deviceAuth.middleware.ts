import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { AppError } from "../types/errors";

const log = logger.child({ module: "deviceAuth" });

/**
 * The single place recorders are authenticated.
 *
 * Every recorder (extension, desktop app, bot, the web page) sends
 * `Authorization: Bearer <DEVICE_TOKEN>`. When DEVICE_TOKEN is unset,
 * which env.ts only allows outside production, requests pass with a
 * one-time warning so local development needs no setup.
 *
 * `token` is injectable for tests; production code uses env.
 */
export const createDeviceAuth = (token: string | null = env.deviceToken) => {
  let warned = false;

  const expected = token ? Buffer.from(token) : null;

  return (req: Request, _res: Response, next: NextFunction) => {
    if (!expected) {
      if (!warned) {
        warned = true;
        log.warn(
          "DEVICE_TOKEN is not set: /api/live accepts unauthenticated " +
            "requests. Set it before exposing the backend."
        );
      }

      return next();
    }

    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());

    if (!match) {
      return next(new AppError("Missing device token.", 401));
    }

    const given = Buffer.from(match[1].trim());

    // Constant-time compare; lengths must match first or
    // timingSafeEqual throws.
    const valid =
      given.length === expected.length &&
      crypto.timingSafeEqual(given, expected);

    if (!valid) {
      return next(new AppError("Invalid device token.", 401));
    }

    return next();
  };
};

export const requireDeviceToken = createDeviceAuth();
