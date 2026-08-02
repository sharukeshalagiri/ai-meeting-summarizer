/**
 * Values shared by the popup, service worker, and offscreen document.
 *
 * MV3 runs these in three separate contexts, so anything they must
 * agree on lives here rather than being repeated three times.
 */

export const DEFAULT_API_BASE = "http://localhost:5000/api";

/** Matches CHUNK_MS in the web app, so both produce comparable audio. */
export const CHUNK_MS = 20_000;

/** URL patterns to platform, used to label the meeting. */
const PLATFORM_PATTERNS = [
  { pattern: /meet\.google\.com/i, platform: "GOOGLE_MEET", label: "Google Meet" },
  { pattern: /zoom\.us/i, platform: "ZOOM", label: "Zoom" },
  {
    pattern: /teams\.(microsoft|live)\.com/i,
    platform: "MICROSOFT_TEAMS",
    label: "Microsoft Teams",
  },
];

export const detectPlatform = (url) => {
  if (!url) return null;

  return (
    PLATFORM_PATTERNS.find((entry) => entry.pattern.test(url)) ?? null
  );
};

/**
 * Google Meet's landing page and Teams' app shell match the same host
 * as a real call, so the path is checked too: a lobby has nothing to
 * record.
 */
export const isInMeeting = (url) => {
  if (!url) return false;

  try {
    const { hostname, pathname, search } = new URL(url);

    if (/meet\.google\.com$/i.test(hostname)) {
      // A call URL is /abc-defg-hij; the home page is / or /landing.
      return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(pathname);
    }

    if (/zoom\.us$/i.test(hostname)) {
      return /\/(j|wc|s)\//i.test(pathname);
    }

    if (/teams\.(microsoft|live)\.com$/i.test(hostname)) {
      return /meetup-join|\/v2\/|calling|conversations/i.test(
        pathname + search
      );
    }
  } catch {
    return false;
  }

  return false;
};

export const getApiBase = async () => {
  const stored = await chrome.storage.local.get("apiBase");

  return stored.apiBase || DEFAULT_API_BASE;
};

/** Session state, kept in storage so the popup can reopen mid-capture. */
export const getSession = async () => {
  const stored = await chrome.storage.local.get("session");

  return stored.session ?? null;
};

export const setSession = (session) =>
  chrome.storage.local.set({ session });

export const clearSession = () =>
  chrome.storage.local.remove("session");
