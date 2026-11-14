# w1-ext decisions (browser capture: extension + web page)

## 1. One capture library, two recorders

`frontend/src/lib/capture/` (TypeScript, framework-free, no
`import.meta.env`) holds the stereo mix, the chunker, the upload queue,
the level meters and the contract client. The web page
(`useLiveCapture`) and the extension's offscreen document both drive it
through `startCaptureSession()`, so the two can't drift apart.

An unpacked extension can't import from outside `extension/` and has no
bundler, so `extension/scripts/build-capture.mjs` transpiles the files
with the frontend's `typescript` (`transpileModule` plus a `.ts` to `.js`
import rewrite) into `extension/lib/capture/`, which **is committed**.
"Load unpacked" then needs no build step. `extensionCopy.test.ts` fails
when the copy is stale.

- Alternatives: a bundler for the extension (adds a build step before
  every load); hand-written JS duplicated in both places (drifts); plain
  JS in `lib/capture` (loses types in the web app).

## 2. Chunk format (one constant: `CHUNK_FORMAT` in `contract.ts`)

| | |
| --- | --- |
| Length | 20 s |
| Codec / container | Opus in WebM (`audio/webm;codecs=opus`), the MediaRecorder default in Chrome. **Container pending an engineer decision**: the desktop recorder proposes Ogg/Opus (same codec). Both decode with ffmpeg, so the backend doesn't care. |
| Sample rate / channels | 48 kHz, 2 channels, 128 kbps |
| Layout | `stereo-mic-left`: L = mic, R = tab |

**Every chunk is a standalone file.** The MediaRecorder is stopped and
restarted per chunk instead of using `start(timeslice)`. Only the first
timeslice blob carries the WebM header, which the old web page got away
with because it uploaded strictly in order and never retried. With a
retrying, out-of-order queue every chunk must decode on its own. The next
recorder is started before the old one is stopped, so the gap is a few
milliseconds. `startOffsetMs` and `durationMs` come from the recording
clock (`performance.now()`), not from upload time.

## 3. Stereo graph

mic → GainNode → merger input 0 (L); tab → GainNode → merger input 1
(R); merger → MediaStreamDestination → MediaRecorder. Merger inputs are
mono, so a stereo tab is down-mixed into R. The mic toggle sets the mic
gain to 0, so the left channel keeps existing as silence and the layout
never changes. With no mic (denied), the file is still stereo with a
silent left channel, which w1-asr skips (`SILENT_CHANNEL_RMS`).

Tab playback: `chrome.tabCapture` mutes the tab, so the offscreen
document routes it back to `ctx.destination`. `getDisplayMedia` (the web
page) does not mute it, so the page doesn't play it back, which would
echo.

Mic constraints: `echoCancellation`, `noiseSuppression` and
`autoGainControl` are on. That keeps remote audio leaking from speakers
out of the mic channel as much as the browser can. w1-asr also drops mic
segments that duplicate remote ones.

## 4. Upload queue

Store first, then upload, and delete only on a 200 (including
`duplicate: true`). Uploads are sequential in `(sessionId, seq)` order,
because each chunk is a Whisper + Gemini call and parallel uploads would
only queue on the server and come back as 409s.

| Response | Action |
| --- | --- |
| 200 / `duplicate: true` | delete |
| 409, 408, 425, 429, 5xx, network error, 2xx without our envelope | keep and back off: 2 s × 2^n, capped at 30 s |
| 401 / 403 | halt the whole queue and keep everything; `resume()` after the token is fixed |
| 410 | drop that session's chunks (the server can never accept them); report the count |
| other 4xx | mark `failed` and keep; never retried |

Store: IndexedDB (`meeting-capture` / `chunks`), shared by the popup
(counts), the offscreen document (uploads while recording) and the
service worker (drains after Stop). The worker drains only when no
offscreen document exists, so two uploaders never race. Server
idempotency would make that safe anyway.

**Stop:** wait up to 60 s (extension) or 2 min (web) for the session's
chunks, then `/end`.
- **Extension:** if chunks remain, `/end` is deferred: the session goes
  into `pendingEnds` and a 1-minute `chrome.alarms` drain uploads and then
  ends it.
- **Web page:** it can't outlive its tab, so it ends anyway and warns
  how many chunks are missing.
- **After `/end`:** both open MeetingDetails. The parallel wiring PR
  makes `/end` return immediately, and MeetingDetails polls.

### Lost-update protection (found in review)

Several contexts write shared state, so no writer may save a copy it
read before a slow call:

- **Chunk records:** retry and reject go through `ChunkStore.update()`,
  which re-reads and writes inside one IndexedDB readwrite transaction
  and does nothing if the chunk is gone. A chunk that the other uploader
  confirmed and deleted is therefore never resurrected, and `attempts`
  builds on the stored value.
- **Session and `pendingEnds`** (`chrome.storage`, worker only): these go
  through `lib/capture/sessionState.ts`, which serializes every
  read-modify-write.
  - `stopping` only goes false to true.
  - Progress patches carry their `sessionId` and are dropped once that
    session is stopping or gone.
  - `pendingEnds` changes only by add or remove of specific IDs. Before
    this fix, a drain saving its stale filtered list could drop an ID
    that Stop added meanwhile, and that session's `/end` was never sent.
- **Drain before `/end`:** `stop()` awaits in-flight `enqueue()` writes
  before flushing. Otherwise the final partial chunk might not be stored
  yet, flush would report 0 left, and `/end` would go out before it.
  Every stop path goes through `stopCapture` in the extension: popup,
  hang-up (`CALL_ENDED`), tab close, navigation and browser restart.
  `/end` is sent only when the queue reports 0 left for that session,
  and otherwise only by the drain after a flush that returns 0.
- **Exception, web page:** it ends after a 2-minute flush timeout even
  with chunks left, because it can't outlive its tab. It tells the user
  how many chunks are missing.

## 5. Permissions

- **Backend host:** the hard-coded `localhost:5000` host permission is
  replaced by `optional_host_permissions: ["http://*/*", "https://*/*"]`.
  The popup requests `<protocol>//<hostname>/*` for the configured
  backend URL on Save or Start, inside a user gesture. Match patterns
  ignore the port.
- **Content scripts:** they stay statically declared for Meet, Zoom and
  Teams. They need no host permission for the backend.
- **Mic:** `permissions.html` asks once. Offscreen documents inherit the
  extension origin's grant, but cannot prompt.
- **New permission:** `alarms`, for the drain.

## 6. Content adapters

One adapter per platform with the same shape (`isInCall`,
`getParticipants`, `getMeetingTitle`), and all selectors in one
`SELECTORS` object per platform. Every lookup degrades to "unknown",
never to an error.

- **Call end:** reported only after the page was *seen* in a call, so a
  broken selector can't stop a recording.
- **Navigation:** a URL change stops the recording only for Meet and Zoom
  call URLs. Teams is a SPA, so only leaving its host counts, and an
  arbitrary "record this tab" session is never stopped by navigation.
- **Zoom:** only `/wc/` is the web client. `/j/`, `/s/`, `/w/` and `/my/`
  are launch pages, which get a banner and a disabled Start button.

## 7. Tests

The frontend had no test runner, so `vitest` is now a frontend
devDependency, with `npm --prefix frontend test` and the root
`test:web`, which `npm test` and `npm run check` include. The tests
cover:

- **Queue:** order, delete-after-confirm, 409 backoff, duplicate, offline
  then online, 401 halt and resume, 410 drop, 400 reject, flush.
- **Contract client:** form fields, Bearer token, network errors.
- **Stereo graph** (fake AudioContext): mic → input 0, tab → input 1,
  per-channel analysers, mic toggle, no-mic case, playback.
- **Levels:** the 30 s silence rule, never flagging a muted mic.
- **Chunker:** one recorder per chunk, `seq` and offsets.
- **Hints parsing**, and freshness of the extension copy.

Not automated: a real browser or call (gate f). The steps are in
`extension/README.md`.

## Requests for other tracks (integrator)

1. **`.github/workflows/ci.yml`** (unowned): add `- run: npm test` to the
   `frontend` job after `npm run lint`. Until then the frontend tests run
   only through `npm test` and `npm run check` locally.
2. **Idle reaper vs. offline backlog (known gap), w3-jobs or
   `live.service.ts` owner:** a recorder that is offline for more than
   `LIVE_SESSION_IDLE_MINUTES` loses its queued chunks. The reaper ends
   the session, and later uploads get 410. Suggested fixes:
   - (a) have the reaper skip sessions whose recorder hasn't called
     `/end`, plus a much longer hard cap (e.g. 6 h), or
   - (b) accept chunks for a reaped (not user-ended) session and re-run
     the final summary when they arrive, or
   - (c) add a cheap `POST /live/sessions/:id/heartbeat` that the
     recorder sends while it holds a backlog.

   (a) is the smallest change.
3. **`frontend/src/types/meeting.ts`** (unowned): `ChunkResult` lacks
   `idx`, `seq` and `duplicate`. The capture lib uses its own
   `ChunkResponse` type, so nothing is blocked, but the shared type could
   be updated or removed.
