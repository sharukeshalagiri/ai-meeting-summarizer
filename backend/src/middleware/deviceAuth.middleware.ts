import { NextFunction, Request, Response } from "express";
import { resolveUser } from "../lib/auth/currentUser";
import { logger } from "../lib/logger";
import { authenticateDevice } from "../services/account/devices.service";
import { AppError } from "../types/errors";

const log = logger.child({ module: "deviceAuth" });

/**
 * The single place recorders are authenticated (/api/live).
 *
 * - With `Authorization: Bearer <token>` (extension, desktop app, bot):
 *   the token must be a live per-user device token from the Devices
 *   page. The capture then belongs to that token's account. A token
 *   that is present but unknown or revoked is always a 401, even if the
 *   request also carries a session cookie: an explicit credential that
 *   fails must never fall back to another one.
 * - Without one (the web app's Live page): the signed-in session.
 *
 * The shared DEVICE_TOKEN of earlier versions is no longer accepted.
 * Recorders keep their settings as they are: they already send their
 * token as a Bearer header; only its value changes.
 *
 * `authenticate` is injectable for tests.
 */
export const createDeviceAuth = (authenticate = authenticateDevice) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization")?.trim();

    if (!header) {
      return resolveUser(req)
        ? next()
        : next(new AppError("Missing device token. Create one on the Devices page.", 401));
    }

    const match = /^Bearer\s+(\S+)$/i.exec(header);

    if (!match) {
      return next(new AppError("Missing device token.", 401));
    }

    authenticate(match[1])
      .then((user) => {
        if (!user) {
          log.info("Device token rejected", { path: req.path });
          return next(new AppError("Invalid or revoked device token.", 401));
        }

        req.user = user;
        next();
      })
      .catch(next);
  };
};

export const requireDeviceToken = createDeviceAuth();
