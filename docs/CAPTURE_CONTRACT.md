# Capture contract

How every recorder sends audio to the backend: the Chrome extension, the
desktop recorder, the web page and a bot. All of them use **the same
endpoints and the same audio format**. Types and limits live in
`backend/src/types/capture.ts`, and this document must match it.

Base URL: `<backend>/api/live`. Every response uses the standard envelope
`{ "success": boolean, "message": string, "data": ... }`. The shapes
below are `data`.

## Auth

Every `/api/live` request sends:

```
Authorization: Bearer <DEVICE_TOKEN>
```

It is checked in one place, `backend/src/middleware/deviceAuth.middleware.ts`.

| Backend `DEVICE_TOKEN` | Behaviour |
| --- | --- |
| set | missing or wrong token gives **401** |
| unset, development | allowed; a warning is logged once |
| unset, `NODE_ENV=production` | the backend **refuses to boot** |

The web page sends `VITE_DEVICE_TOKEN` if it is set. Recorders read the
token from their own settings.

## Audio

- **Accepted format: Opus, 48 kHz, stereo**, in one of two containers:
  - `audio/webm` (the extension and web page, from MediaRecorder);
  - `audio/ogg` (the desktop recorder).

  `ai-service/tests/test_capture_formats.py` checks that both decode
  as 2 channels at 48 kHz through PyAV, the decoder faster-whisper
  uses. Other containers ffmpeg decodes (wav, m4a) still work but are
  not tested. A chunk is usually 10–30 s and must be under
  `MAX_CHUNK_MB`.
- `channelLayout`:
  - `"stereo-mic-left"`: **left channel = the user's microphone, right
    channel = everyone else** (tab or system audio). This is the target
    format for every recorder.
  - `"mono"`: a single mixed channel (the legacy web page and fallbacks).
- The ai-service transcribes a `stereo-mic-left` chunk per channel and a
  `mono` chunk as one stream.

## 1. Start a session

`POST /api/live/sessions` (JSON)

```json
{
  "title": "Weekly sync",
  "platform": "MEET",
  "source": "EXTENSION",
  "mode": "PROJECT",
  "hints": ["Kubernetes", "Priya", "Q3 roadmap"]
}
```

| Field | Required | Values |
| --- | --- | --- |
| `title` | yes | 1–200 chars |
| `platform` | no | `MEET` \| `ZOOM` \| `TEAMS` \| `OTHER` (unknown values are stored as `OTHER`) |
| `source` | no | `EXTENSION` \| `DESKTOP` \| `WEB` \| `BOT` (anything else gives 400) |
| `mode` | no | `GENERAL` \| `LECTURE` \| `INTERVIEW` \| `PROJECT` \| `ONE_ON_ONE` \| `AUTO` (default `AUTO`; anything else gives 400) |
| `hints` | no | up to 20 strings of up to 500 chars: names, jargon, agenda |

**201** →

```json
{ "sessionId": "uuid", "meetingId": "uuid", "meeting": { }, "session": { } }
```

Recorders only need `sessionId` and `meetingId`. `meeting` and `session`
are there for the legacy web page.

## 2. Upload chunks

`POST /api/live/sessions/:sessionId/chunks` (multipart/form-data)

| Field | Required | Meaning |
| --- | --- | --- |
| `audio` | yes | the chunk file |
| `seq` | yes | 0, 1, 2, … per session, in recording order (max 2 147 482) |
| `startOffsetMs` | yes | where this chunk starts on the meeting timeline |
| `durationMs` | yes | chunk length (≤ 10 min) |
| `channelLayout` | no | `stereo-mic-left` \| `mono` (default `mono`) |

**Idempotent on `(sessionId, seq)`.** Retrying is always safe:

| Situation | Response | What the recorder does |
| --- | --- | --- |
| first upload of `seq` | **200**, `duplicate: false` | next chunk |
| `seq` already transcribed | **200**, `duplicate: true`, the original response replayed; nothing re-processed | treat as success |
| `seq` is **still processing** (an earlier upload of it is in flight) | **409** | **Not a failure.** Retry the same chunk later with backoff (e.g. 2 s, 4 s, 8 s … capped at 30 s). Never drop it. |
| `seq` failed earlier | processed again (200 on success) | retry was correct |
| session ended **less than 24 h ago** (by `/end` or the idle reaper) | **200**, processed as a late chunk (see [4. End](#4-end)) | keep draining the queue |
| session ended **more than 24 h ago** | **410** (a transcribed seq still gets 200 `duplicate: true`, at any age) | stop uploading; drop the chunk |
| missing or invalid field | **400** | fix the request; don't retry unchanged |
| upstream failure (Whisper, Gemini) | **502** | retry with backoff |
| bad token | **401** | stop; fix configuration |

**Out-of-order chunks are fine.** Segment timestamps come from
`startOffsetMs`, and each segment's `idx` is `seq * 1000 + i`, so the
transcript is ordered by `seq` whatever the arrival order. Recorders can
upload in parallel or re-send a backlog after a network drop.

**200** →

```json
{
  "sessionId": "uuid",
  "meetingId": "uuid",
  "seq": 3,
  "elapsedMs": 80000,
  "chunkCount": 4,
  "segments": [
    { "idx": 3000, "speaker": "Speaker 1", "text": "…", "startMs": 60000, "endMs": 63200 }
  ],
  "rollingSummaryGenerated": false,
  "duplicate": false
}
```

`elapsedMs` is the furthest chunk end seen so far, so it never moves
backwards. Chunk files are kept on disk (`LiveChunk.path`) for later
re-processing. Retention is w3-jobs' concern.

**Legacy form (web page only):** a multipart field `chunk` with
`durationMs` and **no `seq`** takes the old path. That path appends in
arrival order, uses offsets from the session clock and deletes the file.
New recorders must send `seq`.

## 3. Roster (optional, repeatable)

`POST /api/live/sessions/:sessionId/roster` (JSON)

```json
{ "participants": ["Priya Shah", "Marcus", { "name": "Lena" }] }
```

Replaces the stored list (up to 100 names of up to 120 chars; trimmed and
de-duplicated) on `LiveSession.roster`. Names are **hints** for speaker
attribution (w2-spk); they don't create speakers. **200** →
`{ "sessionId", "roster": [...] }`.

## 4. End

`POST /api/live/sessions/:sessionId/end` (JSON, empty body)

Finalizes the transcript and runs the summary. Calling it twice is safe:
the second call returns `alreadyEnded: true`. Sessions that stop sending
audio for `LIVE_SESSION_IDLE_MINUTES` are ended automatically.

A session that ends with no speech at all is not a failure: the meeting
gets `processingStage: "NO_SPEECH"` (status `COMPLETED`), and the app
shows "No speech detected".

**Late chunks.** Recorders drain their queue before `/end`, but a
network drop, a sleep or the idle reaper can end a session while chunks
are still queued. For **24 hours after it ended**, a session accepts
them:

- Checks run in this order: a `seq` already transcribed replays with
  `duplicate: true` (at any age); after 24 h the answer is **410**;
  otherwise the chunk goes through the normal claim, so 409 and
  failed-retry work as above, and `idx = seq * 1000 + i`.
- The session stays `ENDED`, and no rolling summary runs.
- A late chunk that adds speech (at least one segment) schedules a
  re-summary **2 minutes later**. Each further late chunk restarts that
  timer, so a backlog costs one summary. The transcript and duration
  are then rebuilt from all segments and the summary runs again. A
  `NO_SPEECH` meeting moves to `TRANSCRIBED` first. A chunk that was
  already processing when `/end` arrived and finishes after it does the
  same.
- Silent chunks, duplicates and 409s never schedule a re-summary.
- The timer is in memory: if the backend restarts during those 2
  minutes, the summary stays stale until another late chunk arrives
  (durable jobs are w3-jobs' work).

## Recorder checklist

- [ ] Send `Authorization: Bearer <token>` on every call.
- [ ] Number chunks with `seq` from 0, and compute `startOffsetMs` from
      the recording clock, not upload time.
- [ ] Stereo with mic on the left → `channelLayout: "stereo-mic-left"`.
- [ ] Keep unsent chunks in a local queue. Retry 409, 502 and network
      errors with backoff. Treat `duplicate: true` as success. Stop on
      401 or 410.
- [ ] Call `/end` when the meeting ends. Rely on the idle reaper only as
      a fallback.
