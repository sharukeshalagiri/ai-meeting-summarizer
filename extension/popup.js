import { MEETING_MODES, parseHints } from "./lib/capture/contract.js";
import { IdbChunkStore } from "./lib/capture/uploadQueue.js";
import {
  getSettings,
  hasBackendPermission,
  requestBackendPermission,
  saveSettings,
} from "./shared.js";

/**
 * Toolbar popup: mode, hints, start/stop, timer, meters, upload status
 * and settings. It only talks to the service worker; the popup closes
 * whenever it loses focus, so nothing here may own recording state.
 */

const $ = (id) => document.getElementById(id);

const store = new IdbChunkStore();
let settings = await getSettings();
let current = null;

const show = (el, visible) => el.classList.toggle("hidden", !visible);

const setError = (text) => {
  $("error").textContent = text ?? "";
  show($("error"), Boolean(text));
};

const send = async (message) => {
  const reply = await chrome.runtime.sendMessage(message);

  if (!reply?.ok) throw new Error(reply?.error || "The extension did not respond.");

  return reply.data;
};

const formatElapsed = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
};

const meetingUrl = (meetingId) => `${settings.webBase}/meeting/${meetingId}`;

/* ---------- settings ---------- */

const fillSettings = () => {
  $("api-base").value = settings.apiBase;
  $("device-token").value = settings.deviceToken;
  $("web-base").value = settings.webBase;
};

$("save-settings").addEventListener("click", async () => {
  const next = {
    apiBase: $("api-base").value || settings.apiBase,
    deviceToken: $("device-token").value,
    webBase: $("web-base").value || settings.webBase,
  };

  try {
    new URL(next.apiBase);
    new URL(next.webBase);
  } catch {
    $("settings-status").textContent = "Enter full URLs, e.g. http://localhost:5000/api.";
    $("settings-status").className = "tiny error";
    return;
  }

  // Requested first, while the click still counts as a user gesture.
  const granted = await requestBackendPermission(next.apiBase).catch(() => false);

  await saveSettings(next);
  settings = await getSettings();
  fillSettings();

  $("settings-status").textContent = granted
    ? "Saved. The extension may talk to this backend."
    : "Saved, but access to the backend was not allowed; recording will not start.";
  $("settings-status").className = granted ? "tiny ok" : "tiny error";

  // A fixed token or URL may unblock the backlog.
  void send({ type: "DRAIN" }).catch(() => undefined);
});

/* ---------- mic permission ---------- */

const checkMic = async () => {
  try {
    const state = await navigator.permissions.query({ name: "microphone" });

    show($("mic-missing"), state.state !== "granted");
  } catch {
    show($("mic-missing"), false);
  }
};

$("grant-mic").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") });
});

/* ---------- start / stop ---------- */

for (const mode of MEETING_MODES) {
  const option = document.createElement("option");

  option.value = mode.value;
  option.textContent = mode.label;
  $("mode").append(option);
}

$("start").addEventListener("click", async () => {
  setError(null);

  const tabId = current?.tab?.id;

  if (tabId === undefined) return;

  $("start").disabled = true;
  $("start").textContent = "Starting...";

  try {
    // Must happen inside the click (user gesture), before any other await.
    if (!(await hasBackendPermission(settings.apiBase))) {
      const granted = await requestBackendPermission(settings.apiBase);

      if (!granted) throw new Error("Access to the backend URL is needed to upload audio.");
    }

    await chrome.storage.local.set({ lastMode: $("mode").value, lastHints: $("hints").value });

    await send({
      type: "START",
      tabId,
      mode: $("mode").value,
      hints: parseHints($("hints").value),
    });
  } catch (error) {
    setError(error.message);
  } finally {
    $("start").disabled = false;
    $("start").textContent = "Start recording";
    void refresh();
  }
});

$("stop").addEventListener("click", async () => {
  setError(null);
  show($("rec-view"), false);
  show($("after-view"), true);
  $("after-text").textContent = "Uploading the last chunks and finishing the meeting...";

  try {
    const result = await send({ type: "STOP" });

    if (!result) return;

    if (result.ended) {
      // Same flow as the web page: go to MeetingDetails once /end is accepted.
      void chrome.tabs.create({ url: `${result.webBase}/meeting/${result.meetingId}` });
      $("after-text").textContent = "Meeting ended. The summary opens in a new tab.";
    } else {
      $("after-text").textContent =
        `${result.remaining} chunk(s) still waiting. They upload automatically ` +
        "when the backend is reachable, then the meeting is finalized.";
    }
  } catch (error) {
    setError(error.message);
  }
});

$("mic-toggle").addEventListener("click", async () => {
  try {
    await send({ type: "MIC", enabled: !(current?.session?.micEnabled ?? false) });
  } catch (error) {
    setError(error.message);
  }

  void refresh();
});

/* ---------- live levels from the offscreen document ---------- */

const paintMeter = (id, channel, off) => {
  const meter = $(id);

  meter.firstElementChild.style.width = `${off ? 0 : Math.round(channel.level * 100)}%`;
  meter.classList.toggle("silent", channel.silent);
};

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "OFFSCREEN_LEVELS") return false;

  const { levels, micEnabled } = message;

  paintMeter("mic-meter", levels.mic, !micEnabled);
  paintMeter("tab-meter", levels.tab, false);
  $("mic-state").textContent = !micEnabled ? "off" : levels.mic.silent ? "silent for 30 s" : "";
  $("mic-state").className = levels.mic.silent ? "warn" : "muted";
  $("tab-state").textContent = levels.tab.silent ? "silent for 30 s" : "";
  $("tab-state").className = levels.tab.silent ? "warn" : "muted";

  return false;
});

/* ---------- status ---------- */

const render = async () => {
  const { session, tab, pendingEnds } = current;
  const waiting = (await store.list()).filter((chunk) => !chunk.failed).length;
  const recording = Boolean(session);

  show($("idle-view"), !recording && $("after-view").classList.contains("hidden"));
  show($("rec-view"), recording);

  if (tab) {
    $("tab-status").textContent = tab.supported
      ? `${tab.platform}${tab.inMeeting ? "" : " (not in a call yet)"}`
      : "This tab is not Meet, Zoom or Teams. Its audio can still be recorded.";
  }

  show($("zoom-launch"), Boolean(tab?.zoomLaunchPage) && !recording);
  $("start").disabled = !tab || Boolean(tab.zoomLaunchPage);

  if (recording) {
    $("rec-platform").textContent = session.platform;
    $("timer").textContent = formatElapsed(Date.now() - session.startedAt);
    $("meeting-link").href = meetingUrl(session.meetingId);
    $("mic-toggle").textContent = !session.hasMic ? "No mic" : session.micEnabled ? "Mute mic" : "Unmute mic";
    $("mic-toggle").disabled = !session.hasMic;

    const queue = session.queue ?? {};
    const parts = [`${session.chunkCount} chunk(s) uploaded`];

    if (waiting) parts.push(`${waiting} chunk(s) waiting${queue.lastRetry ? ` (${queue.lastRetry})` : ""}`);
    if (queue.failed) parts.push(`${queue.failed} rejected`);

    $("upload-status").textContent = parts.join(" · ");
    $("upload-status").className = queue.halted ? "tiny error" : "tiny";

    if (queue.halted && queue.halted !== "disposed") {
      setError(`Uploads paused: ${queue.halted}. Fix the device token in Settings.`);
    } else if (session.lastError) {
      setError(session.lastError);
    }
  }

  $("backlog").textContent =
    !recording && (waiting || pendingEnds.length)
      ? `${waiting} chunk(s) waiting to upload` +
        (pendingEnds.length ? `; ${pendingEnds.length} meeting(s) to finalize.` : ".")
      : "";
};

const refresh = async () => {
  try {
    current = await send({ type: "STATUS" });
    await render();
  } catch (error) {
    setError(error.message);
  }
};

const restoreForm = async () => {
  const { lastMode, lastHints } = await chrome.storage.local.get(["lastMode", "lastHints"]);

  if (lastMode) $("mode").value = lastMode;
  if (lastHints) $("hints").value = lastHints;
};

fillSettings();
await restoreForm();
await checkMic();
await refresh();
setInterval(refresh, 1000);
