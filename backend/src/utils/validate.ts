import { BadRequest } from "../types/errors";

/**
 * Small parsing helpers for untrusted request bodies.
 *
 * `req.body` is `any` at the Express boundary; funnelling it through
 * these keeps that looseness from spreading into services, without
 * pulling in a schema library for a handful of fields.
 */

export const requireString = (
  value: unknown,
  field: string,
  { maxLength = 500 }: { maxLength?: number } = {}
): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw BadRequest(`${field} is required`);
  }

  const trimmed = value.trim();

  if (trimmed.length > maxLength) {
    throw BadRequest(
      `${field} must be ${maxLength} characters or fewer`
    );
  }

  return trimmed;
};

export const optionalString = (
  value: unknown,
  { maxLength = 5000 }: { maxLength?: number } = {}
): string | null => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return value.trim().slice(0, maxLength);
};

/**
 * Reads a route parameter, rejecting a missing or empty value.
 *
 * Express types params as `string | string[]` because a path can
 * repeat a name; these routes never do, so an array means a malformed
 * request rather than something to concatenate.
 */
export const requireParam = (
  value: string | string[] | undefined,
  field: string
): string => {
  if (Array.isArray(value)) {
    throw BadRequest(`${field} must be a single value`);
  }

  if (!value || !value.trim()) {
    throw BadRequest(`${field} is required`);
  }

  return value;
};
