import { createCaptureClient } from "./lib/capture/contract.js";
import { SessionState, chromeStorageArea } from "./lib/capture/sessionState.js";
import { IdbChunkStore, UploadQueue } from "./lib/capture/uploadQueue.js";
import {
  STOP_FLUSH_MS,
  detectPlatform,
  getSettings,
  hasBackendPermission,
  isInMeeting,
  isZoomLaunchPage,
} from "./shared.js";

/**
 * Service worker: owns the session lifecycle and talks to the backend
 * (capture contract, docs/CAPTURE_CONTRACT.md).
 *
 * It cannot record audio (MV3 workers have no MediaRecorder and no DOM),
 * so recording happens in an offscreen document that this worker
 * creates. The offscreen document uploads chunks while it lives; chunks
 * it could not upload stay in IndexedDB and this worker drains them on
 * an alarm, then calls /end. See extension/README.md.
 */

const OFFSCREEN_PATH = "offscreen.html";

/**
 * Every read-modify-write of the stored session and pendingEnds goes
 * through this serialized state (see lib/capture/sessionState.js), so a
 * late progress message or a slow drain can never save a stale copy over
 * the write Stop made.
 */
const state = new SessionState(chromeStorageArea(chrome.storage.local));
const DRAIN_ALARM = "drain-chunks";

const ZOOM_LAUNCH_MESSAGE =
  "Click 'Join from your browser' to record here, or use the desktop recorder.";

const clientFor = (settings) =>
  createCaptureClient({ apiBase: settings.apiBase, token: settings.deviceToken });

/** Chrome allows exactly one offscreen document per extension. */
const ensureOffscreen = async () => {
  if (await chrome.offscreen.hasDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Recording the meeting tab and microphone for transcription.",
  });
};

const closeOffscreen = async () => {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
};

/** The badge is the recording indicator on the toolbar icon. */
const setBadge = (text, color = "#b91c1c") => {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
};

/**
 * Messages for the offscreen document carry target: "offscreen", since
 * runtime.sendMessage reaches every extension page. Retries cover the
 * moment before a freshly created document registers its listener.
 */
const sendToOffscreen = async (message, attempts = 10) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage({ ...message, target: "offscreen" });

      if (reply === undefined) throw new Error("Offscreen document not ready");
      if (!reply.ok) {
        const failure = new Error(reply.error || "Offscreen document failed");

        failure.fatal = true;
        throw failure;
      }

      return reply.data;
    } catch (error) {
      if (error?.fatal || attempt >= attempts - 1) throw error;

      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
};

/** Asks the meeting tab's content script for title/participants; null if absent. */
const askContentScript = async (tabId) => {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_MEETING_INFO" });
  } catch {
    return null;
  }
};

const startCapture = async ({ tabId, mode, hints }) => {
  // Early check so no backend session is created; startSession below
  // re-checks atomically for two Starts racing.
  if (await state.getSession()) {
    throw new Error("Already recording. Stop the current recording first.");
  }

  const settings = await getSettings();

  if (!(await hasBackendPermission(settings.apiBase))) {
    throw new Error("Allow access to the backend URL first (Settings, then Save).");
  }

  const tab = await chrome.tabs.get(tabId);

  if (isZoomLaunchPage(tab.url)) throw new Error(ZOOM_LAUNCH_MESSAGE);

  const detected = detectPlatform(tab.url);
  const info = await askContentScript(tabId);

  // getMediaStreamId must be called from the worker (the popup click
  // granted activeTab for this tab); the offscreen document redeems it.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const client = clientFor(settings);
  const created = await client.startSession({
    title: (info?.title || tab.title || "Browser meeting").trim().slice(0, 200),
    platform: detected?.platform ?? "OTHER",
    source: "EXTENSION",
    mode,
    hints,
  });

  const session = {
    sessionId: created.sessionId,
    meetingId: created.meetingId,
    tabId,
    title: tab.title ?? "",
    platform: detected?.label ?? "Browser tab",
    platformCode: detected?.platform ?? null,
    startedAt: Date.now(),
    chunkCount: 0,
    elapsedMs: 0,
    hasMic: false,
    micEnabled: false,
    queue: { pending: 0, failed: 0, halted: null, lastRetry: null },
    lastError: null,
  };

  try {
    await state.startSession(session);
  } catch (error) {
    await client.endSession(session.sessionId).catch(() => undefined);
    throw error;
  }

  try {
    await ensureOffscreen();

    const started = await sendToOffscreen({
      type: "OFFSCREEN_START",
      streamId,
      sessionId: session.sessionId,
      apiBase: settings.apiBase,
      token: settings.deviceToken,
    });

    session.hasMic = started.hasMic;
    session.micEnabled = started.hasMic;
    await state.patchSession(session.sessionId, {
      hasMic: started.hasMic,
      micEnabled: started.hasMic,
    });
  } catch (error) {
    // Nothing was recorded: end the empty session and clean up.
    await closeOffscreen().catch(() => undefined);
    await state.clearSession(session.sessionId);
    await client.endSession(session.sessionId).catch(() => undefined);
    throw error;
  }

  setBadge("REC");

  if (info?.participants?.length) {
    void client.sendRoster(session.sessionId, info.participants).catch(() => undefined);
  }

  return session;
};

let stopping = null;

/**
 * Stops recording, waits up to STOP_FLUSH_MS for the queue, then ends
 * the session. /end is sent only when the offscreen queue reports 0
 * chunks left for this session; otherwise the session goes to
 * pendingEnds and the drain sends /end once its chunks are uploaded.
 * Every path (popup Stop, hang-up, tab close, navigation, browser
 * restart) comes through here.
 */
const stopCapture = () => {
  stopping ??= (async () => {
    // From here on, progress patches for this session are dropped.
    const session = await state.markStopping();

    if (!session) return null;

    setBadge("...", "#6b7280");

    let remaining = null;

    try {
      const reply = await sendToOffscreen(
        { type: "OFFSCREEN_STOP", flushTimeoutMs: STOP_FLUSH_MS },
        2
      );

      remaining = reply.remaining;
    } catch {
      // The offscreen document is gone (crash, browser restart); its
      // chunks, if any, are still in IndexedDB.
    }

    await closeOffscreen().catch(() => undefined);
    await state.clearSession(session.sessionId);
    setBadge("");

    const settings = await getSettings();
    let ended = false;

    if (remaining === 0) {
      try {
        await clientFor(settings).endSession(session.sessionId);
        ended = true;
      } catch (error) {
        console.error("Could not end the session; will retry", error);
      }
    }

    if (!ended) {
      await state.addPendingEnd(session.sessionId);
      await chrome.alarms.create(DRAIN_ALARM, { periodInMinutes: 1 });
      void drainBacklog();
    }

    return {
      meetingId: session.meetingId,
      ended,
      remaining: remaining ?? 0,
      webBase: settings.webBase,
    };
  })().finally(() => {
    stopping = null;
  });

  return stopping;
};

let draining = null;

/**
 * Uploads chunks left behind by a stopped recording, then ends their
 * sessions. Skipped while recording: the offscreen queue drains every
 * session in the shared store itself.
 */
const drainBacklog = () => {
  draining ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;

    const settings = await getSettings();

    if (!(await hasBackendPermission(settings.apiBase))) return;

    const client = clientFor(settings);
    const store = new IdbChunkStore();
    const done = new Set();
    const queue = new UploadQueue({
      store,
      upload: (chunk) => client.uploadChunk(chunk),
      // 410: the server already ended it (idle reaper); nothing to end.
      onSessionEnded: (sessionId) => done.add(sessionId),
    });

    for (const sessionId of await state.getPendingEnds()) {
      const left = await queue.flush(sessionId, 25_000);

      if ((await queue.state()).halted) break;
      if (left > 0 || done.has(sessionId)) continue;

      try {
        await client.endSession(sessionId);
        done.add(sessionId);
      } catch (error) {
        // 404/410 mean there is nothing left to end; anything else
        // retries on the next alarm.
        if (error?.status === 404 || error?.status === 410) done.add(sessionId);
      }
    }

    // Chunks of sessions not in pendingEnds (e.g. after a crash) are
    // uploaded too; they are idempotent on the server.
    const orphans = new Set(
      (await store.list())
        .filter((chunk) => !chunk.failed && !done.has(chunk.sessionId))
        .map((chunk) => chunk.sessionId)
    );

    for (const sessionId of orphans) {
      if ((await queue.state()).halted) break;
      await queue.flush(sessionId, 25_000);
    }

    queue.dispose();

    // Remove only the ids finished here; an id Stop added meanwhile stays.
    const pendingEnds = await state.removePendingEnds(done);

    const leftover = (await store.list()).filter((chunk) => !chunk.failed);

    if (pendingEnds.length === 0 && leftover.length === 0) {
      await chrome.alarms.clear(DRAIN_ALARM);
    }

    return { pendingEnds: pendingEnds.length, chunks: leftover.length };
  })().finally(() => {
    draining = null;
  });

  return draining;
};

const setMic = async (enabled) => {
  const session = await state.getSession();

  if (!session || session.stopping) throw new Error("Not recording.");

  const { micEnabled } = await sendToOffscreen({ type: "OFFSCREEN_MIC", enabled });

  await state.patchSession(session.sessionId, { micEnabled });

  return micEnabled;
};

const sendRoster = async (tabId, participants) => {
  const session = await state.getSession();

  if (!session || session.stopping || session.tabId !== tabId || !participants?.length) return;

  const settings = await getSettings();

  await clientFor(settings)
    .sendRoster(session.sessionId, participants)
    .catch(() => undefined);
};

const status = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const detected = detectPlatform(tab?.url);

  return {
    session: await state.getSession(),
    pendingEnds: await state.getPendingEnds(),
    tab: tab
      ? {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          platform: detected?.label ?? null,
          supported: Boolean(detected),
          inMeeting: isInMeeting(tab.url),
          zoomLaunchPage: isZoomLaunchPage(tab.url),
        }
      : null,
  };
};

/**
 * Progress from the offscreen document, folded into the stored session
 * for the popup. Dropped if that session is stopping or gone.
 */
const recordProgress = (sessionId, patch) => {
  if (sessionId) void state.patchSession(sessionId, patch);
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Meant for the offscreen document, which answers it itself.
  if (message?.target === "offscreen") return false;

  switch (message?.type) {
    case "OFFSCREEN_PROGRESS":
      recordProgress(message.sessionId, {
        chunkCount: message.chunkCount,
        elapsedMs: message.elapsedMs,
      });
      return false;
    case "OFFSCREEN_QUEUE":
      recordProgress(message.sessionId, { queue: message.queue });
      return false;
    case "OFFSCREEN_ERROR":
      console.error("Capture error:", message.error);
      recordProgress(message.sessionId, { lastError: message.error });
      return false;
    case "OFFSCREEN_TAB_ENDED":
      void stopCapture();
      return false;
    case "ROSTER":
      if (sender.tab?.id !== undefined) void sendRoster(sender.tab.id, message.participants);
      return false;
    case "CALL_ENDED":
      void state.getSession().then((session) => {
        if (session && session.tabId === sender.tab?.id) void stopCapture();
      });
      return false;
    default:
      break;
  }

  const handlers = {
    START: () => startCapture(message),
    STOP: () => stopCapture(),
    STATUS: () => status(),
    MIC: () => setMic(Boolean(message.enabled)),
    DRAIN: () => drainBacklog(),
  };

  const handler = handlers[message?.type];

  if (!handler) return false;

  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));

  // Keeps the channel open for the async response.
  return true;
});

/** Closing the meeting tab ends the meeting, so the capture ends with it. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await state.getSession();

  if (session?.tabId === tabId) await stopCapture();
});

/**
 * Navigating away from the call also ends it. Only for meeting
 * platforms: an arbitrary tab ("record this tab") may navigate freely.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;

  const session = await state.getSession();

  if (session?.tabId === tabId && session.platformCode && !isInMeeting(changeInfo.url)) {
    await stopCapture();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DRAIN_ALARM) void drainBacklog();
});

/**
 * A browser restart loses the offscreen document but not the stored
 * session: finish it (its chunks are in IndexedDB) instead of leaving a
 * stale REC badge and an orphaned session.
 */
chrome.runtime.onStartup.addListener(async () => {
  if (await state.getSession()) await stopCapture();
  else void drainBacklog();
});
