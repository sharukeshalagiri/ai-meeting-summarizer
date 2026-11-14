# Meeting AI Assistant (Chrome extension)

Records Google Meet, Zoom (web client) and Microsoft Teams (web) calls in
Chrome and sends them to the backend over the
[capture contract](../docs/CAPTURE_CONTRACT.md):

- **Stereo:** left channel = your microphone (echo cancellation and noise
  suppression on), right channel = the meeting tab.
- **20 s chunks**, WebM/Opus, 48 kHz, 128 kbps, each a standalone file,
  `channelLayout: "stereo-mic-left"` (`CHUNK_FORMAT` in
  `frontend/src/lib/capture/contract.ts`; the container is pending an
  engineer decision so it matches the desktop recorder).
- **Reliable upload:** each chunk goes to IndexedDB first, uploads with
  backoff (2 s, 4 s, ... 30 s), and is deleted only after the server
  confirms it. A 409 means "still processing, retry later", and
  `duplicate: true` counts as done. Chunks left after Stop (when you're
  offline) are uploaded by the service worker every minute, and then the
  meeting is finalized.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3. The backend host is an *optional* host permission, requested for the URL you configure. |
| `background.js` | Service worker: session start/stop, badge, roster relay, drains the backlog. |
| `offscreen.html` / `offscreen.js` | Hidden page that records: tab stream, played back to you, plus the mic, mixed to stereo, chunked and queued. |
| `permissions.html` / `.js` | One-time microphone grant (an offscreen page cannot prompt). |
| `popup.html` / `.js` / `.css` | Mode, names and terms, start/stop, timer, level meters, upload status, settings. |
| `content.js` | One adapter per platform (`isInCall`, `getParticipants`, `getMeetingTitle`). All selectors are in `SELECTORS`. |
| `shared.js` | Settings, permissions and URL rules for the popup and the worker. |
| `lib/capture/*.js` | **Generated** from `frontend/src/lib/capture/*.ts`. Don't edit these directly. |
| `scripts/build-capture.mjs` | Regenerates `lib/capture` (`--check` verifies it). |
| `scripts/make-icons.mjs` | Draws the placeholder icons (original artwork, no logos). |

After changing `frontend/src/lib/capture/`, run
`node extension/scripts/build-capture.mjs`. The frontend test
`extensionCopy.test.ts` fails if you forget.

## Install (load unpacked)

1. Start the backend (`npm run dev` or `npm run dev:api`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick this `extension/` folder. Chrome 116 or newer is
   required.
3. Click the toolbar icon, then open **Settings** and enter:
   - **Backend URL:** e.g. `http://localhost:5000/api` (a track worktree
     uses its own port, e.g. `http://localhost:5110/api`).
   - **Device token:** only if the backend sets `DEVICE_TOKEN`.
   - **Web app URL:** e.g. `http://localhost:5173`. The meeting link opens
     here.
   Click **Save** and accept Chrome's prompt to allow the backend's host.
4. **Grant the mic once:** the popup shows "Allow microphone". It opens
   `permissions.html`; click **Allow microphone** and accept. Without
   this, the extension still records but the left channel stays silent.

## Test steps (about 2 minutes each)

Before each test: tell the other people in the call that you're
recording.

**Google Meet**

1. Join a call at `meet.google.com/xxx-xxxx-xxx` (a second device or a
   friend helps).
2. Click the icon. It should say "Google Meet". Pick a mode, type a name
   in "Names and terms" and click **Start recording**.
3. Check: the badge shows **REC**, you can still hear the call, the
   "You (mic)" meter moves when you speak and "Meeting (tab)" moves when
   they speak.
4. After about 45 s the popup shows "2 chunk(s) uploaded". Click **Open
   meeting** to see transcript lines arriving.
5. **Mute mic**: the mic meter drops to 0 and no silence warning appears.
6. Click **Stop and summarize**. MeetingDetails opens in a new tab and the
   badge clears.
7. Hang-up variant: start again, then leave the call from Meet's red
   button. Within about 10 s the recording stops by itself.

**Zoom (browser)**

1. Open a Zoom invite link (`zoom.us/j/...`). On the launch page the
   popup and a banner on the page both say "Click 'Join from your
   browser' to record here, or use the desktop recorder", and Start is
   disabled.
2. Click **Join from your browser**. The URL becomes `.../wc/...`. Then
   follow steps 2–6 from Meet.

**Microsoft Teams (web)**

1. Join a meeting at `teams.microsoft.com` (or `teams.live.com`) in Chrome.
2. Follow steps 2–6 from Meet. Closing the tab also stops the recording.

**Offline / retry**

1. Start recording in any call, then stop the backend (Ctrl+C) for about
   1 minute.
2. The popup shows "N chunk(s) waiting (Network error)". Recording
   continues.
3. Restart the backend. Within 30 s the waiting count drops to 0, and the
   transcript has no gaps.
4. Variant: stop the backend, click **Stop and summarize**, wait about
   1 min, then restart it. The popup reports chunks waiting. Within about
   1–2 minutes they upload and the meeting is finalized. This only works
   if the backend comes back within `LIVE_SESSION_IDLE_MINUTES` (10); see
   "Known gaps".

**Silent channel warning**

- Record a call with your system mic muted for 30 s. "You (mic)" shows
  "silent for 30 s" in amber.
- Record a tab with nothing playing. "Meeting (tab)" shows the same.

## Roster and titles

`content.js` sends participant names to `/roster` every 30 s while the
recorded tab is in a call. Names are only hints for speaker attribution.
The meeting title comes from the page, or else from the tab title. When a
platform changes its markup, update only its entry in `SELECTORS`. If a
selector fails, names are missing, but recording keeps working.

## Known gaps

- **Offline for longer than the idle timeout:** if the backend sees no
  chunks for `LIVE_SESSION_IDLE_MINUTES` (default 10), the idle reaper ends
  the session. Chunks still queued then get **410** and are dropped, and
  the popup reports how many. A backend fix has been requested (see
  `docs/decisions/w1-ext.md`).
- The recorder is restarted every 20 s, which leaves a gap of a few
  milliseconds between chunks.
- The platform selectors are best-effort and have not been verified
  against every account type or UI language.
