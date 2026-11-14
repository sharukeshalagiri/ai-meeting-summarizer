/**
 * Values shared by the popup and the service worker (ES module).
 *
 * The offscreen document cannot use chrome.storage, so it gets its
 * settings in the START message instead of importing this file.
 * content.js is a classic script and keeps its own copy of the
 * platform rules it needs.
 */

export const DEFAULT_SETTINGS = {
  apiBase: "http://localhost:5000/api",
  deviceToken: "",
  /** Where MeetingDetails lives: `${webBase}/meeting/<id>`. */
  webBase: "http://localhost:5173",
};

/** How long Stop waits for queued chunks before ending the session. */
export const STOP_FLUSH_MS = 60_000;

export const getSettings = async () => {
  const stored = await chrome.storage.local.get(["apiBase", "deviceToken", "webBase"]);

  return {
    apiBase: stored.apiBase || DEFAULT_SETTINGS.apiBase,
    deviceToken: stored.deviceToken || "",
    webBase: stored.webBase || DEFAULT_SETTINGS.webBase,
  };
};

export const saveSettings = (settings) =>
  chrome.storage.local.set({
    apiBase: settings.apiBase.trim().replace(/\/+$/, ""),
    deviceToken: settings.deviceToken.trim(),
    webBase: settings.webBase.trim().replace(/\/+$/, ""),
  });

/**
 * Host permission pattern for the backend. Match patterns ignore the
 * port, so http://localhost:5110/api becomes http://localhost/*.
 */
export const originPattern = (apiBase) => {
  const url = new URL(apiBase);

  return `${url.protocol}//${url.hostname}/*`;
};

export const hasBackendPermission = (apiBase) =>
  chrome.permissions.contains({ origins: [originPattern(apiBase)] });

/** Must run inside a user gesture (a click in the popup). */
export const requestBackendPermission = (apiBase) =>
  chrome.permissions.request({ origins: [originPattern(apiBase)] });

/** URL -> contract platform (MEET | ZOOM | TEAMS) and a label. */
const PLATFORM_PATTERNS = [
  { pattern: /(^|\.)meet\.google\.com$/i, platform: "MEET", label: "Google Meet" },
  { pattern: /(^|\.)zoom\.us$/i, platform: "ZOOM", label: "Zoom" },
  { pattern: /^teams\.(microsoft|live)\.com$/i, platform: "TEAMS", label: "Microsoft Teams" },
];

const hostOf = (url) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

export const detectPlatform = (url) => {
  const parsed = url && hostOf(url);

  if (!parsed) return null;

  return PLATFORM_PATTERNS.find((entry) => entry.pattern.test(parsed.hostname)) ?? null;
};

/** Zoom's web client (app.zoom.us/wc/..., <org>.zoom.us/wc/...). */
export const isZoomWebClient = (url) => {
  const parsed = url && hostOf(url);

  return Boolean(parsed && /zoom\.us$/i.test(parsed.hostname) && /^\/wc\//i.test(parsed.pathname));
};

/**
 * A Zoom join/launch page (/j/123, /s/123, /w/123) that hands off to the
 * desktop app. There is no call audio in this tab to record.
 */
export const isZoomLaunchPage = (url) => {
  const parsed = url && hostOf(url);

  return Boolean(
    parsed &&
      /zoom\.us$/i.test(parsed.hostname) &&
      !isZoomWebClient(url) &&
      /^\/(j|s|w|my)\//i.test(parsed.pathname)
  );
};

/**
 * Whether the URL can be a call. Used to stop recording when the tab
 * navigates away. Meet keeps the call URL after hanging up, so content.js
 * also reports CALL_ENDED from the page itself.
 */
export const isInMeeting = (url) => {
  const parsed = url && hostOf(url);
  const detected = detectPlatform(url);

  if (!parsed || !detected) return false;

  if (detected.platform === "MEET") {
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(parsed.pathname);
  }

  if (detected.platform === "ZOOM") return isZoomWebClient(url);

  // Teams is a single-page app whose URLs change during a call; only
  // leaving the Teams host counts as leaving.
  return true;
};

/** Session state, kept in storage so the popup can reopen mid-capture. */
export const getSession = async () => (await chrome.storage.local.get("session")).session ?? null;

export const setSession = (session) => chrome.storage.local.set({ session });

export const clearSession = () => chrome.storage.local.remove("session");

/**
 * Sessions stopped while chunks were still queued: the worker calls
 * /end for each once its chunks are uploaded.
 */
export const getPendingEnds = async () =>
  (await chrome.storage.local.get("pendingEnds")).pendingEnds ?? [];

export const setPendingEnds = (pendingEnds) => chrome.storage.local.set({ pendingEnds });
