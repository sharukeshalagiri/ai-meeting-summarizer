/**
 * Rejects keys that could escape the storage root. Keys are built by the
 * server, never taken from a request, so this is a guard against bugs.
 */
export const assertKey = (key: string): string => {
  const normalized = key.replace(/\\/g, "/");

  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Invalid storage key: ${key}`);
  }

  return normalized;
};
