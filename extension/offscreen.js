import { createCaptureClient } from "./lib/capture/contract.js";
import { getMicStream, startCaptureSession } from "./lib/capture/session.js";
import { IdbChunkStore } from "./lib/capture/uploadQueue.js";

/**
 * Offscreen document: the only extension context that can record.
 *
 * Tab audio (right channel) comes from the streamId the worker got from
 * chrome.tabCapture; the mic (left channel) from getUserMedia, which
 * only works here after permissions.html granted it once (offscreen
 * documents cannot show a permission prompt). The stereo mix, 20 s
 * chunks and the IndexedDB upload queue are the same code the web page
 * uses (extension/lib/capture, generated from frontend/src/lib/capture).
 *
 * This page has chrome.runtime only (no chrome.storage), so settings
 * arrive in the START message.
 */

let capture = null;

let currentSessionId = null;

/**
 * Every message names its session, so the worker can drop progress for
 * a session that is already stopping (no stale write over Stop).
 */
const notify = (message) => {
  // No listener (popup closed) is normal; the worker always listens.
  chrome.runtime
    .sendMessage({ ...message, sessionId: currentSessionId })
    .catch(() => undefined);
};

const openTabStream = (streamId) =>
  navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });

const start = async ({ streamId, sessionId, apiBase, token }) => {
  if (capture) throw new Error("Already recording.");

  currentSessionId = sessionId;

  const tab = await openTabStream(streamId);
  const mic = await getMicStream();
  const client = createCaptureClient({ apiBase, token });

  capture = startCaptureSession({
    sessionId,
    client,
    store: new IdbChunkStore(),
    tab,
    mic,
    // Capturing a tab mutes it for the user; play it back so they can
    // still hear the meeting.
    playTab: true,
    onLevels: (levels) =>
      notify({
        type: "OFFSCREEN_LEVELS",
        levels,
        micEnabled: capture?.mix.isMicEnabled() ?? false,
      }),
    onQueue: (queue) => notify({ type: "OFFSCREEN_QUEUE", queue }),
    onUploaded: (response) =>
      notify({
        type: "OFFSCREEN_PROGRESS",
        chunkCount: response.chunkCount,
        elapsedMs: response.elapsedMs,
      }),
    onSessionEnded: (dropped) =>
      notify({
        type: "OFFSCREEN_ERROR",
        error: `The server ended the session; ${dropped} chunk(s) were dropped.`,
      }),
    onError: (error) => notify({ type: "OFFSCREEN_ERROR", error }),
  });

  // The tab stream ends when the tab closes or the capture is revoked.
  tab
    .getAudioTracks()[0]
    ?.addEventListener("ended", () => notify({ type: "OFFSCREEN_TAB_ENDED" }));

  return { hasMic: capture.mix.hasMic };
};

const stop = async ({ flushTimeoutMs }) => {
  if (!capture) return { remaining: 0 };

  const current = capture;

  capture = null;

  return { remaining: await current.stop(flushTimeoutMs) };
};

const handlers = {
  OFFSCREEN_START: start,
  OFFSCREEN_STOP: stop,
  OFFSCREEN_MIC: async ({ enabled }) => {
    capture?.setMicEnabled(enabled);
    return { micEnabled: capture?.mix.isMicEnabled() ?? false };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  const handler = handlers[message.type];

  if (!handler) return false;

  handler(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));

  return true;
});
