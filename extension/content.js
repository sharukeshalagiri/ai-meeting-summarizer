/**
 * Content script for Meet, Zoom (web client) and Teams (web).
 *
 * One adapter per platform with the same shape:
 *   { isInCall(), getParticipants(), getMeetingTitle() }
 * and every DOM selector in one object per platform (SELECTORS), because
 * these apps change their markup without notice: when a platform
 * breaks, only its entry here needs updating. Selectors are lists; the
 * first that matches wins. Everything degrades to "unknown" (no title,
 * no names), never to an error: recording does not depend on this file.
 *
 * Classic script (content scripts cannot be ES modules), so it does not
 * import shared.js.
 */
(() => {
  if (window.__meetingAiContent) return;
  window.__meetingAiContent = true;

  const ROSTER_INTERVAL_MS = 30_000;
  const CALL_POLL_MS = 5_000;

  const SELECTORS = {
    MEET: {
      inCall: [
        'button[aria-label*="Leave call" i]',
        'button[aria-label*="leave the call" i]',
        "[data-call-ended='false']",
      ],
      participants: [
        "[data-participant-id] [data-self-name]",
        "[role='listitem'][data-participant-id] [jsslot] span",
        "[data-requested-participant-id] [data-self-name]",
      ],
      // Participant tiles carry the name as an attribute in some builds.
      participantAttributes: ["data-self-name", "aria-label"],
      title: ["[data-meeting-title]", "[data-meeting-code]"],
    },
    ZOOM: {
      inCall: [
        "button.footer__leave-btn",
        "button[aria-label*='Leave' i]",
        ".footer-button__leave",
      ],
      participants: [
        ".participants-item__display-name",
        ".participants-item__name-label",
        ".video-avatar__avatar-name",
      ],
      participantAttributes: [],
      title: [".meeting-info-container__meeting-topic", ".meeting-title", ".meeting-topic"],
    },
    TEAMS: {
      inCall: [
        "#hangup-button",
        "button[data-tid='hangup-main-btn']",
        "button[data-tid='call-hangup']",
      ],
      participants: [
        "[data-tid='roster-participant'] [data-tid='roster-participant-name']",
        "[role='treeitem'] [data-tid*='participant'] span[title]",
        "[data-cid='roster-participant'] span[title]",
      ],
      participantAttributes: ["title"],
      title: ["[data-tid='call-title']", "[data-tid='entity-header'] h2", "h1[data-tid]"],
    },
  };

  const platformOf = (location) => {
    const host = location.hostname;

    if (/(^|\.)meet\.google\.com$/i.test(host)) return "MEET";
    if (/(^|\.)zoom\.us$/i.test(host)) return "ZOOM";
    if (/^teams\.(microsoft|live)\.com$/i.test(host)) return "TEAMS";

    return null;
  };

  const isZoomWebClient = () => /^\/wc\//i.test(window.location.pathname);

  const isZoomLaunchPage = () =>
    platformOf(window.location) === "ZOOM" &&
    !isZoomWebClient() &&
    /^\/(j|s|w|my)\//i.test(window.location.pathname);

  const firstMatch = (selectors) => {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);

        if (el) return el;
      } catch {
        // An invalid selector in one build must not break the others.
      }
    }

    return null;
  };

  const textOf = (el, attributes = []) => {
    for (const attribute of attributes) {
      const value = el.getAttribute?.(attribute);

      if (value?.trim()) return value.trim();
    }

    return el.textContent?.trim() ?? "";
  };

  /** Names from the first selector that finds any; trimmed, de-duplicated, capped. */
  const collectNames = (config) => {
    for (const selector of config.participants) {
      let nodes;

      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }

      const names = [
        ...new Set(
          [...nodes]
            .map((el) => textOf(el, config.participantAttributes))
            .map((name) => name.replace(/\s*\((you|me|host|guest)\)\s*$/i, "").trim())
            .filter((name) => name && name.length <= 120)
        ),
      ];

      if (names.length) return names.slice(0, 100);
    }

    return [];
  };

  /** Strips "Meet - ", "| Microsoft Teams" and similar from the tab title. */
  const cleanDocumentTitle = (title) =>
    title
      .replace(/^Meet\s*[-–]\s*/i, "")
      .replace(/\s*[|–-]\s*(Microsoft Teams|Zoom|Google Meet)\s*$/i, "")
      .trim();

  const makeAdapter = (platform) => {
    const config = SELECTORS[platform];

    return {
      isInCall: () => {
        if (platform === "ZOOM" && !isZoomWebClient()) return false;

        return Boolean(firstMatch(config.inCall));
      },
      getParticipants: () => collectNames(config),
      getMeetingTitle: () => {
        const el = firstMatch(config.title);
        const fromDom = el ? textOf(el, ["data-meeting-title"]) : "";
        const title = fromDom || cleanDocumentTitle(document.title);

        // A bare Meet code (abc-defg-hij) is not a useful title.
        if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(title)) return "Google Meet call";

        return title.slice(0, 200);
      },
    };
  };

  const platform = platformOf(window.location);

  if (!platform) return;

  const adapter = makeAdapter(platform);

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // Extension reloaded: this orphaned script can no longer talk to it.
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "GET_MEETING_INFO") return false;

    sendResponse({
      platform,
      inCall: adapter.isInCall(),
      title: adapter.getMeetingTitle(),
      participants: adapter.getParticipants(),
      zoomLaunchPage: isZoomLaunchPage(),
    });

    return false;
  });

  /* Roster every 30 s; the worker ignores it unless this tab is recording. */
  setInterval(() => {
    if (!adapter.isInCall()) return;

    const participants = adapter.getParticipants();

    if (participants.length) send({ type: "ROSTER", participants });
  }, ROSTER_INTERVAL_MS);

  /*
   * Call-end detection: Meet keeps the call URL after hanging up, so the
   * worker's URL check alone misses it. Only a call we saw running can
   * end, so a selector that never matches cannot stop a recording.
   */
  let sawCall = false;
  let missed = 0;

  setInterval(() => {
    if (adapter.isInCall()) {
      sawCall = true;
      missed = 0;
      return;
    }

    if (sawCall && ++missed >= 2) {
      sawCall = false;
      send({ type: "CALL_ENDED" });
    }
  }, CALL_POLL_MS);

  /* Zoom launch page: there is no call audio in this tab. */
  if (isZoomLaunchPage()) {
    const banner = document.createElement("div");

    banner.setAttribute("role", "note");
    banner.style.cssText =
      "position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);" +
      "max-width:520px;padding:10px 14px;border-radius:8px;background:#111827;color:#fff;" +
      "font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);cursor:pointer";
    banner.textContent =
      "Meeting AI Assistant: Click 'Join from your browser' to record here, or use the desktop recorder. (click to dismiss)";
    banner.addEventListener("click", () => banner.remove());
    document.documentElement.append(banner);
  }
})();
