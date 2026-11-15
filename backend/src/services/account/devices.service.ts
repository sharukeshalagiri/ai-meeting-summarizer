import type { AuthUser } from "../../lib/auth/currentUser";
import {
  displayPrefix,
  generateDeviceToken,
  hashDeviceToken,
} from "../../lib/auth/tokens";
import { logger } from "../../lib/logger";
import * as deviceRepo from "../../repositories/deviceToken.repository";
import { BadRequest, NotFound } from "../../types/errors";

const log = logger.child({ module: "devices.service" });

/**
 * Per-user device tokens (Devices page). Each recorder gets its own
 * token, so one can be revoked without touching the others, and every
 * capture is owned by the account whose token sent it.
 */

export const DEVICE_KINDS = ["EXTENSION", "DESKTOP", "OTHER"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const MAX_ACTIVE_TOKENS = 20;

export const listDevices = (userId: string) => deviceRepo.findByUser(userId);

/** Creates a token. The plain token is returned once and never stored. */
export const createDevice = async (input: {
  userId: string;
  name: string;
  kind: string | null;
}) => {
  const kind = (input.kind ?? "OTHER").toUpperCase();
  if (!DEVICE_KINDS.includes(kind as DeviceKind)) {
    throw BadRequest(`kind must be one of: ${DEVICE_KINDS.join(", ")}`);
  }

  const active = (await deviceRepo.findByUser(input.userId)).filter((d) => !d.revokedAt);
  if (active.length >= MAX_ACTIVE_TOKENS) {
    throw BadRequest(`Revoke a device first (at most ${MAX_ACTIVE_TOKENS} active tokens).`);
  }

  const token = generateDeviceToken();
  const device = await deviceRepo.create({
    userId: input.userId,
    name: input.name.trim().slice(0, 80),
    kind,
    tokenHash: hashDeviceToken(token),
    prefix: displayPrefix(token),
  });

  log.info("Device token created", { userId: input.userId, deviceId: device.id, kind });

  return { device, token };
};

export const revokeDevice = async (userId: string, deviceId: string) => {
  const device = await deviceRepo.findOwned(deviceId, userId);
  if (!device) throw NotFound("Device not found");

  await deviceRepo.revoke(deviceId, userId);
  log.info("Device token revoked", { userId, deviceId });

  return { ...device, revokedAt: device.revokedAt ?? new Date() };
};

/** lastUsedAt is written at most this often per token. */
const MARK_EVERY_MS = 60 * 1000;
const lastMarked = new Map<string, number>();

/**
 * The user a Bearer token belongs to, or null when it is unknown or
 * revoked. Revocation is checked on every request (no cache), so a
 * revoked token stops working on the next chunk.
 */
export const authenticateDevice = async (token: string): Promise<AuthUser | null> => {
  if (!token || token.length > 200) return null;

  const row = await deviceRepo.findByHash(hashDeviceToken(token));
  if (!row || row.revokedAt) return null;

  const now = Date.now();
  if (now - (lastMarked.get(row.id) ?? 0) > MARK_EVERY_MS) {
    lastMarked.set(row.id, now);
    void deviceRepo.markUsed(row.id).catch(() => undefined);
  }

  return { ...row.user, deviceTokenId: row.id };
};
