import {
  clearSession,
  detectPlatform,
  getApiBase,
  getSession,
  isInMeeting,
  setSession,
} from "./shared.js";

/**
 * Service worker: owns session lifecycle and talks to the backend.
 *
 * It cannot record audio itself — MV3 service workers have no
 * MediaRecorder and no DOM — so capture happens in an offscreen
 * document, which this worker creates and drives. See EXTENSION.md.
 */

const OFFSCREEN_PATH = "offscreen.html";

/** Chrome allows exactly one offscreen document per extension. */
const ensureOffscreen = async () => {
  const existing = await chrome.offscreen.hasDocument();

  if (existing) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification:
      "Recording tab audio to transcribe the meeting.",
  });
};

const closeOffscreen = async () => {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
};

/** Badge doubles as the recording indicator on the toolbar icon. */
const setBadge = (text, color = "#b91c1c") => {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
};

const post = async (path, body) => {
  const base = await getApiBase();

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.success) {
    throw new Error(
      payload?.message ?? `Request failed (${response.status})`
    );
  }

  return payload.data;
};

const startCapture = async (tabId) => {
  const tab = await chrome.tabs.get(tabId);

  const detected = detectPlatform(tab.url);

  // getMediaStreamId must be called from the worker; the offscreen
  // document cannot obtain one for a tab by itself.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId,
  });

  const data = await post("/live/sessions", {
    title: tab.title?.trim() || "Browser meeting",
    platform: detected?.platform ?? "OTHER",
  });

  const session = {
    sessionId: data.session.id,
    meetingId: data.meeting.id,
    tabId,
    apiBase: await getApiBase(),
    title: tab.title ?? "",
    platform: detected?.label ?? "Browser",
    startedAt: Date.now(),
    chunkCount: 0,
    elapsedMs: 0,
  };

  await setSession(session);

  await ensureOffscreen();

  // The offscreen document may still be booting; retrying covers the
  // window before its message listener is registered.
  await sendToOffscreen({
    type: "START",
    streamId,
    sessionId: session.sessionId,
    apiBase: session.apiBase,
  });

  setBadge("REC");

  return session;
};

const sendToOffscreen = async (message, attempts = 5) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (attempt === attempts - 1) throw error;

      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
};

const stopCapture = async () => {
  const session = await getSession();

  if (!session) return null;

  try {
    await sendToOffscreen({ type: "STOP" });
  } catch {
    // The offscreen document may already be gone; the session still
    // needs finalizing either way.
  }

  await closeOffscreen();

  try {
    await post(`/live/sessions/${session.sessionId}/end`, {});
  } catch (error) {
    console.error("Could not finalize session", error);
  }

  await clearSession();

  setBadge("");

  return session;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Messages from the offscreen document are namespaced so they do not
  // collide with the popup's commands.
  if (message?.type === "OFFSCREEN_PROGRESS") {
    void getSession().then((session) => {
      if (!session) return;

      void setSession({
        ...session,
        chunkCount: message.chunkCount ?? session.chunkCount,
        elapsedMs: message.elapsedMs ?? session.elapsedMs,
      });
    });

    return false;
  }

  if (message?.type === "OFFSCREEN_ERROR") {
    console.error("Capture error", message.error);
    return false;
  }

  const handlers = {
    START: () => startCapture(message.tabId),
    STOP: () => stopCapture(),
    STATUS: async () => {
      const session = await getSession();
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      const detected = detectPlatform(tab?.url);

      return {
        session,
        tab: tab
          ? {
              id: tab.id,
              title: tab.title,
              url: tab.url,
              platform: detected?.label ?? null,
              supported: Boolean(detected),
              inMeeting: isInMeeting(tab.url),
            }
          : null,
      };
    },
  };

  const handler = handlers[message?.type];

  if (!handler) return false;

  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({ ok: false, error: error.message ?? String(error) })
    );

  // Keeps the message channel open for the async response.
  return true;
});

/**
 * Closing the meeting tab ends the meeting, so the capture should end
 * with it rather than recording silence.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();

  if (session?.tabId === tabId) {
    await stopCapture();
  }
});

/**
 * Navigating away from the call — hanging up returns to a landing page
 * — also ends the meeting.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;

  const session = await getSession();

  if (session?.tabId === tabId && !isInMeeting(changeInfo.url)) {
    await stopCapture();
  }
});

// A worker restart loses the offscreen document but not the stored
// session, which would leave a stale REC badge and an orphaned row.
chrome.runtime.onStartup.addListener(async () => {
  if (await getSession()) {
    await stopCapture();
  }
});
