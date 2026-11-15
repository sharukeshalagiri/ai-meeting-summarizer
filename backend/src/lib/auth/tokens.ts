import crypto from "crypto";

/**
 * Per-user device tokens for recorders (extension, desktop app).
 *
 * A token is 32 random bytes, base64url, with a recognisable prefix so
 * a leaked one is easy to grep for. Only its SHA-256 is stored: a token
 * has 256 bits of entropy, so a fast hash is enough (a slow password
 * hash only matters for guessable secrets), and lookup stays a single
 * indexed equality on DeviceToken.tokenHash.
 */

export const DEVICE_TOKEN_PREFIX = "amsd_";

export const generateDeviceToken = (): string =>
  DEVICE_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");

export const hashDeviceToken = (token: string): string =>
  crypto.createHash("sha256").update(token, "utf8").digest("hex");

/** What the Devices page shows to tell tokens apart ("amsd_Ab3x…"). */
export const displayPrefix = (token: string): string =>
  token.slice(0, DEVICE_TOKEN_PREFIX.length + 4);
