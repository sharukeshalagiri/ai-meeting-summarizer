# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## End goal

A **personal meeting companion**, built as a portfolio project: not built
for scale, but built like a real product (live demo, auth, background
jobs, tests, CI, measured accuracy).

- **Capture.** Google Meet and Zoom/Teams opened in the browser are
  captured by the Chrome extension. The Zoom desktop app, or any other
  desktop call app, is captured by a desktop recorder. Both send the
  **same stereo audio format** to the same backend: **left channel = my
  mic, right channel = everyone else**.
- **Understand.** Transcribe, attribute every line to a speaker, and
  produce a short summary with no filler: tasks (owner + deadline),
  decisions, dates, open questions, plus mode-specific output for
  lectures, interviews, projects and 1:1s.
- **Trace.** Every summary item links back to the moment it was said
  (a segment `idx`, played from its `startMs`).

The current code handles uploads and live capture from three recorders,
on top of the shared foundation for parallel work: the capture contract,
the reserved schema, the UI contract, ownership rules and CI. Pair 1 has
added stereo-aware transcription with faster-whisper (w1-asr) and the
summary pipeline v2 (w1-sum), wired in by `chore/pair-1-wiring`. Pair 2
has added the recorders, all on the capture contract: the Chrome
extension and the web Live page (w1-ext) and the desktop recorder
(w1-desk). Pair 3 has added voice speaker attribution with stable labels
across chunks, automatic names and renames (w2-spk), and an evaluation
harness with a regression gate and a browser e2e (w2-eval). Pair 4 has
added durable background jobs on pg-boss, with progress over SSE
(w3-jobs, wired in by `chore/pair-4-wiring`), and production Docker
images, a compose file and a deploy guide (w3-infra). Wave 4 has added
accounts (w4-acct): email + password sign-in with server-side sessions,
every query scoped by user, per-user device tokens for recorders,
settings, audio retention, exports and meeting series. w3-jobs part 2
then moved the end of the live flow onto jobs: `/end` assembles the
chunks into one recording and runs the full pipeline on it. Wave 5
added demo mode and public-instance safety (w5-demo): a read-only demo
account with three synthetic meetings, rate limits, an audio-length cap,
generated README screenshots and accuracy table. The integration after
it wired the demo into the deploy, added proxy security headers, an
image-build workflow and the tag-driven release workflow.

Not done yet: the accepted eval baseline and the AMI DER run
(`eval/baseline.json` is a placeholder, so the README accuracy table
says "not yet measured"), a deployed public instance, and a
Content-Security-Policy (see `docs/DECISIONS.md`).

## Operating mode (every session follows this)

**Roles.** The user is the engineer and makes the decisions. You are the
developer, architect, tester and release manager. **You run every git,
gh, npm, pip, docker and test command yourself. Never ask the user to run
a command you can run.**

**Decision gates: the ONLY times you stop and ask.**

- **(a)** Approval of your plan, before you write code.
- **(b)** Merging any PR, or pushing to `main`.
- **(c)** Schema or migration changes (`backend/prisma/**`).
- **(d)** Deleting files, branches, worktrees, databases or data.
  **Exception:** you may delete an uncommitted scratch file that your
  own session created, without asking. Anything committed, or created
  by someone else, still goes through this gate.
- **(e)** Anything involving accounts, API keys, costs, public releases,
  GitHub settings, or other people's data.
- **(f)** A real-world test only the user can do: a live Meet/Zoom call,
  installing the browser extension, granting a desktop OS permission.
  Give them a script that takes 2 minutes or less, then wait for their
  result.

**How to ask.** Lead with the decision. Give 2–3 options with their
consequences and mark your recommendation. Keep it under 10 lines.

**Everything else: just do it,** then report at the end in 5 lines or
fewer: what changed, what was tested, and what needs the user's
decision.

`.claude/settings.json` enforces these gates mechanically (see
[Permissions](#permissions-claudesettingsjson-committed)).

## Architecture

| Service | Stack | Default port | Env var for the port |
| --- | --- | --- | --- |
| `frontend/` | React 19, Vite 8, Tailwind 4, react-router 7 | 5173 | `FRONTEND_PORT` |
| `backend/` | Express 5, TypeScript, Prisma 6, Gemini (`@google/genai`) | 5000 | `PORT` |
| `ai-service/` | FastAPI + faster-whisper (CPU int8 / CUDA float16), sherpa-onnx speaker embeddings (`POST /diarize`) | 8000 | `AI_SERVICE_PORT` |
| PostgreSQL | `pgvector/pgvector:pg16` via `docker-compose.yml` | 5433 (host) | `POSTGRES_PORT` |
| `extension/` | Chrome MV3, loaded unpacked (see [Recorders](#recorders)) | — | — |
| `desktop-recorder/` | Python 3.11+ tray app (see [Recorders](#recorders)) | — | — |
| `eval/`, `e2e/` | tsx + vitest harness; Playwright (own `package.json` each) | — | — |

The frontend reaches the backend through `VITE_API_URL`, and the backend
reaches the ai-service through `AI_SERVICE_URL`. Only the backend talks to
the database and to Gemini.

### Upload flow

```
NewMeeting.tsx
  POST /api/meetings                         create Meeting (status CREATED)
  POST /api/meetings/:id/audio  (multer)     file -> backend/uploads/meetings
  POST /api/meetings/:id/process            202, returns at once (meeting.service startProcessing)
        one queue per step (jobs/definitions.ts), singletonKey = meetingId;
        each step commits, then queues the next and writes its processingStage
  job meeting-transcribe   TRANSCRIBING
        speech.service -> transcription provider (TRANSCRIPTION_PROVIDER: local | deepgram)
          local: ai-service POST /transcribe { file_path (absolute), offset_ms, channel_layout, hints }
        parseSegments drops noSpeechProb > 0.75; segments keep channel + words
        -> storage artifact artifacts/<meetingId>/asr.json (lib/storage)
  job meeting-diarize      DIARIZING
        diarization.service diarizeSegments with the meeting context (the whole file is one
          chunk at offset 0): DIARIZATION_PROVIDER applies, as for live chunks (see Speakers)
        -> Transcript + TranscriptSegment rows (replaced; channel, words), durationSec
           no segments -> NO_SPEECH, status COMPLETED (stops here)
  job meeting-clean        CLEANING     CLEAN noise labels -> noiseLabel per segment
  job meeting-summarize    SUMMARIZING  w1-sum pipeline v2 (CLASSIFY? CLEAN EXTRACT VERIFY)
          on error: note in processingError, legacy generateSummary used instead
        -> Summary (data.schemaVersion 2, data.pipeline "v2" | "legacy"), ActionItem rows
        -> processingStage DONE, status COMPLETED; asr.json removed
  job meeting-index        (no stage)   embedding.service -> SegmentEmbedding (float8[], unit-normalized)
  failure: transient kinds retried with backoff; then FAILED,
        processingError "[STAGE/KIND] user-safe message" (jobs/errors.ts)
  GET  /api/meetings/:id/events             SSE: progress rows, `event: end` once settled
        NewMeeting / MeetingDetails / SummaryView follow it (useMeetingProgress);
        fallback: poll GET /api/meetings/:id every 5 s
  POST /api/meetings/:id/retry              202: segments exist -> from CLEAN, else transcribe again
```

The worker runs in the API process (`server.ts` starts it after
`listen` and stops it on SIGTERM/SIGINT). Jobs live in Postgres, in
pg-boss's own `pgboss` schema (not Prisma), so a run survives a backend
restart. While any pipeline job for a meeting is waiting or running,
process, summarize and retry queue nothing new and return the current
state (still 202). The older endpoints still work on top of the jobs:

- `POST /:id/transcribe` queues the pipeline and waits (up to
  `TRANSCRIPTION_TIMEOUT_MINUTES`, then 504) for the transcript, which it
  returns as before. The summary carries on as a job.
- `POST /:id/summarize` (202) queues only the summarize job.
- `POST /:id/upload` attaches the file and queues the pipeline. Its
  response has `transcript: null`, `summary: null` and `processing`.
- `POST /:id/resummarize` (w1-sum) queues a summarize job and waits up
  to `RESUMMARIZE_WAIT_MS` (4.5 min). After that it answers 200
  `{ queued: true, summary: null, actionItems: null, ... }` and the job
  carries on. A re-summarize leaves `status` as it was, so a failure
  shows only in `processingStage` FAILED.
- `POST /:id/index` still indexes in the request.

**When the queue is down** (pg-boss could not start; `server.ts` retries
every 30 s), every route that queues work answers 503 "Background
processing is unavailable right now. Try again shortly." before writing
any stage: process, retry, events, summarize, resummarize, upload, live
`/end`, and a late chunk on an ended live session. Reads still work, and
chunks of an ACTIVE session are still transcribed (they need no queue). `GET /api/health` is always 200 and reports
`queue: "up" | "down"`; `GET /api/health/ready` is 503 while it is down.
The root `GET /health` is pure liveness.

**The ai-service reads the file by path**, so it must share a filesystem
with the backend.

### Live capture flow (capture contract)

Every recorder (extension, desktop recorder, web page, bot) uses the
**capture contract** in [`docs/CAPTURE_CONTRACT.md`](docs/CAPTURE_CONTRACT.md)
(types in `backend/src/types/capture.ts`):

```
Recorder (stereo: left = my mic, right = everyone else)
  Authorization: Bearer <device token>      per-user token from the Devices page (amsd_…);
                                            one middleware: middleware/deviceAuth.middleware.ts
        unknown or revoked token -> 401 (even with a session cookie);
        no header -> the session cookie (web Live page); the capture belongs to that account
        /live/sessions/:id of another account -> 404, before multer stores anything
  POST /api/live/sessions {title, platform, source, mode, hints[]} -> {sessionId, meetingId}
  POST /api/live/sessions/:id/chunks  multipart: audio, seq, startOffsetMs, durationMs, channelLayout
        LiveChunk row claimed on (sessionId, seq): idempotent
          duplicate of a transcribed seq -> 200 {duplicate:true} (replayed)
          same seq still processing      -> 409 (retry later with backoff; not a failure)
          failed seq                     -> processed again
        Whisper with offset = startOffsetMs
        -> diarizeSegments with the meeting context (see Speakers below)
        -> segments at idx = seq*1000 + i (sparse; the draft), speakerId linked by idx
        session.elapsedMs = max(elapsedMs, startOffsetMs + durationMs)
        rolling summary every ROLLING_SUMMARY_MINUTES (best effort, ACTIVE sessions only)
        chunk file kept (LiveChunk.path) for assembly; retention deletes it with the recording
        session ENDED < 24 h ago: a late chunk (queue down -> 503 before any work);
          with speech -> job live-late (singletonKey sessionId, starts 2 min later;
            re-queues itself until 2 min without a chunk and no pipeline step running)
            -> draft transcript rebuilt -> final pass again (origin "late")
          ENDED > 24 h ago -> 410 (a transcribed seq still replays)
  POST /api/live/sessions/:id/roster {participants[]}   -> LiveSession.roster (name hints)
  POST /api/live/sessions/:id/end
        queue down -> 503 before any write (the session stays ACTIVE; the recorder's retry
          is a fresh /end). Repeated /end on ENDED with no stage and nothing running
          -> queues the final pass that never got queued
        draft segments -> Transcript, status TRANSCRIBED
          (no segments and no FAILED chunk -> NO_SPEECH, COMPLETED, stops here)
        LiveChunk rows exist -> meeting.service startLiveFinal (origin "live-final"):
  job live-assemble        ASSEMBLING   jobs/assemble.ts, ffmpeg (FFMPEG_PATH)
        each chunk decoded to 16 kHz PCM at its startOffsetMs; gaps, missing seqs,
          missing or undecodable files -> silence of the same length
        stereo only if every chunk is stereo-mic-left, else mono
        -> recordings/<meetingId>/live.ogg (Opus) + manifest.json; Meeting.audioPath = live.ogg
  job meeting-transcribe -> meeting-diarize -> clean -> summarize -> index (the upload chain)
        diarize, final pass (jobs/liveFinal.ts): the new segments REPLACE the draft,
          dense idx 0..n-1; speaker + speakerId copied from the draft segment that
          overlaps most on the same channel (>= 30%); the rest -> diarizeSegments;
          action-item evidence re-pointed by time; Corrections untouched;
          an empty final transcript never replaces a draft with speech
        assembly / transcribe / diarize fails for good -> keepLiveDraft: the draft is
          summarized from CLEAN, note "The full recording could not be processed again,
          so the summary uses the live transcript." (no draft -> NO_SPEECH)
        no LiveChunk rows (legacy chunk form) -> job meeting-summarize on the draft, no assembly
  job live-reap            cron */5 * * * * (registered by the server, never in tests):
        ends sessions idle > LIVE_SESSION_IDLE_MINUTES, the same way as /end
```

Chunk transcription, speaker attribution and rolling summaries still run
in the chunk request, on purpose: the recorder gets the segments in the
response. Everything after `/end`, late chunks and the reaper are durable
jobs (`jobs/live.ts`).

Every recorder in the repo now uses the contract, the web Live page
included (`useLiveCapture.ts` on `frontend/src/lib/capture/`). The
backend still accepts the **legacy** form of the chunk call (a `chunk`
field with no `seq`): it appends in arrival order, takes offsets from the
session clock and deletes the file, so such a session gets no assembly
or final pass. No client here sends it any more. New recorders must use
the contract.

Playback: `GET /api/meetings/:id/audio` streams the stored recording with
HTTP Range support (`res.sendFile`). It is owner-checked like every
`/meetings/:id` path (another account's meeting is a 404), and `<audio>`
sends the session cookie by itself. After the audio-retention job has
deleted a recording (`audioDeletedAt` set, `audioPath` cleared) it is a
404 too. A live meeting plays once ASSEMBLING has finished
(`audioPath` points at `recordings/<id>/live.ogg`); before that, or when
no chunk audio could be assembled, it is a 404.

### Speakers (w2-spk)

```
diarizeSegments(segments, context?)          services/diarization.service.ts
  mic channel -> always the user: SpeakerProfile "mic", shown as Settings display name,
                 else ME_DISPLAY_NAME ("You")
  with a meeting context (uploads, live chunks, final-pass leftovers):
    DIARIZATION_PROVIDER voice (default): ai-service POST /diarize, sherpa-onnx embeddings,
      clusters per chunk -> services/speakers/matcher.ts matches them to the meeting's
      SpeakerProfile centroids (serialised per meeting, in-process lock)
      unavailable -> text -> continuity -> "Speaker 1" (attribution never fails a chunk)
    text: Gemini from the conversation; deepgram: paid, label-stable only
  without one (eval): Gemini text labels, plus the mic rule
names (services/speakers/names.ts): applied only with two signals, otherwise a suggestion
GET /api/meetings/:id/speakers ; PATCH /:id/speakers/:key {displayName} ; POST /:id/speakers/:key/accept
  rename -> profile (MANUAL) + segments' speaker + SPEAKER Correction via record()
TranscriptView: rename chip, suggestion chip, "Hide noise" (folds noiseLabel != substantive)
```

Renames show everywhere at read time: `withSpeakerNames` runs on the
meeting, summary, summary-review, resummarize and export reads, and
`withOwnerNames` on `GET /action-items` (`speakers.service.ts`).

### Accounts and auth (w4-acct)

```
POST /api/auth/login | logout | signup (AUTH_ALLOW_SIGNUP) ; GET /api/auth/me ; POST /api/auth/password
  passport-local + express-session, PrismaSessionStore (Session table), argon2id
  cookie ams.sid: httpOnly, SameSite=Lax, Secure in production, rolling SESSION_MAX_AGE_DAYS
routes/index.ts: /auth and /health public; /live device auth; everything else requireUser
  /meetings/:id/*  requireMeetingAccess (another account's meeting = 404, same as missing)
  lists pass userId down to SQL; single-row writes check the owner (services/account/access.service.ts)
/api/account/settings   display name ("You" label), timezone, default mode, provider, glossary, audio retention
/api/devices            create (token shown once), list, POST /:id/revoke
/api/series             list, create, rename; GET /:id/prep
/api/meetings/:id/export?format=json|md|pdf&transcript=1 ; POST /:id/export/email (503 without SMTP_HOST)
/api/meetings/:id/series (PUT) ; POST /:id/since-last-time/:itemId {apply|dismiss}
job audio-retention     RETENTION_CRON; deletes recordings only, per each user's setting
GET /api/demo {enabled, readOnly} ; POST /api/demo/login (DEMO_MODE only, else 404)   public (w5-demo)
  demo account demo@example.com: no password, session DEMO_SESSION_HOURS;
  middleware/demo.middleware.ts: every non-GET is 403 for it (deny by default),
  GET /api/search is a keyword search for it (no Gemini call)
middleware/rateLimit.middleware.ts (after the session is read): per user, else per IP
  (last X-Forwarded-For entry only behind a private-address proxy); 429 + Retry-After;
  heavy POSTs (uploads, processing, chat, sign-ins) share an hourly budget;
  MAX_AUDIO_MINUTES: ffprobe before transcribe/process/retry, live chunks past the cap 413,
  single-request POST /:id/upload refused while a cap is set
```

The frontend sends the cookie (`withCredentials` in `api.ts` and on the
progress EventSource). A 401 outside `/auth/` fires `ams:auth-required`,
and `Layout` (which holds `AuthProvider`) redirects to `/login?next=…`.
Pages: `Login`, `Settings`, `Devices`, `Prep`. The reasons are in
`docs/DECISIONS.md` (the w4-acct entries).

Search and Q&A: `GET /api/search` and `POST /api/chat` embed the query and
run cosine similarity in SQL over `SegmentEmbedding`. Analytics:
`GET /api/analytics`. Tasks: `GET/PATCH /api/action-items`. Every route
is assembled in `backend/src/routes/index.ts`.

### Shared contracts (stable; build on them, don't redesign them)

- **Segment references are always `TranscriptSegment.idx`, never array
  positions.** This applies to summary evidence, chat citations,
  corrections and `jumpToSegment`. Upload idx values are dense (0..n-1).
  Live idx values are sparse (`seq * 1000 + i`) during the call; the live
  final pass replaces the draft with dense idx values (0..n-1) and
  re-points kept action-item evidence by time. A late chunk is inserted
  at its sparse idx again until the next final pass renumbers. So never
  cache an idx across a final pass; anchor on `startMs` when you must.
  See [`docs/SCHEMA_NOTES.md`](docs/SCHEMA_NOTES.md) (it describes the
  sparse phase only).
- **Schema reservation:** the `parallel_foundation` migration added every
  field Waves 1–3 need: `Meeting.mode` and `processing*`;
  `TranscriptSegment.channel`, `noiseLabel`, `words` and `speakerId`;
  `SpeakerProfile`; `Correction` (write it through
  `repositories/correction.repository.ts` `record()`); the extra
  `ActionItem` fields; `LiveSession.source`, `hints` and `roster`; and
  `LiveChunk`. `docs/SCHEMA_NOTES.md` explains every field and who fills
  it.
- **UI contract:** `TranscriptView` renders every segment as
  `<span id="seg-<idx>" data-start-ms=…>`. `frontend/src/lib/audio/`
  provides `AudioPlayerProvider` (on `MeetingDetails`), `<AudioPlayer>`
  (registers the `<audio>`), `useAudioPlayer()` →
  `{ seekTo(ms), jumpToSegment(idx), hasAudio }`, and the DOM helper
  `scrollToSegment(idx)`. `jumpToSegment` switches to the transcript tab,
  scrolls, highlights and plays from the segment's start.
- **Provider types:** `TranscriptionProvider` and `DiarizationProvider`
  in `backend/src/types/providers.ts`, both implemented.
  Transcription: `backend/src/providers/transcription/` (`local`,
  `deepgram`), through `AsrProvider`, which extends
  `TranscriptionProvider` with the previous chunk's words. Diarization:
  `backend/src/services/speakers/providers.ts` (`voice`, `text`,
  `deepgram`).

The reasons behind these choices (chunked Whisper instead of streaming,
voice diarization with a text fallback, `float8[]` instead of pgvector,
embedding batching, live assembly and the final pass) are in
**`docs/DECISIONS.md`**. Read it before changing any of them, and add an
entry when you make a decision like these.

### Recorders

All three send stereo chunks (left = mic, right = everyone else) under
the capture contract and authenticate with a per-user device token (the
web page uses the session cookie).

- **`extension/`** (w1-ext): Chrome MV3, Chrome 116+, loaded unpacked;
  install and 2-minute test steps are in `extension/README.md`. The
  popup, offscreen recorder, permissions page, content script and
  placeholder icons all exist. The backend URL defaults to
  `http://localhost:5000/api` and is set in the popup's Settings; the
  backend host is an *optional* host permission requested for that URL.
  `extension/lib/capture/*.js` is **generated** from
  `frontend/src/lib/capture/*.ts` by `node extension/scripts/build-capture.mjs`
  (the frontend test `extensionCopy.test.ts` fails if it drifts).
- **Web Live page** (w1-ext): `hooks/useLiveCapture.ts` on the same
  `frontend/src/lib/capture/` code; tab audio plus the mic, 20 s chunks
  kept in IndexedDB until confirmed.
- **`desktop-recorder/`** (w1-desk): Python 3.11+ tray app for desktop
  call apps; `source: "DESKTOP"`. Windows (WASAPI loopback) is built and
  tested; Linux and macOS are untested. Durable on-disk queue. Tests:
  `npm run test:desktop`. Details in `desktop-recorder/README.md`.


## Setup and commands

Prerequisites: Node 22+, Python 3.10+, Docker (for Postgres), ffmpeg on
PATH. Whisper needs it to decode audio, and the backend uses it to
assemble live recordings (`FFMPEG_PATH`; without it the live final pass
is skipped and the draft is summarized).

```bash
# one-time
npm run setup                 # root + backend + frontend npm install, ai-service venv + requirements
cp backend/.env.example backend/.env           # set DATABASE_URL, GEMINI_API_KEY
cp ai-service/.env.example ai-service/.env     # optional
cp frontend/.env.example frontend/.env.local   # optional
cp .env.example .env                           # optional, docker compose overrides

# run
npm run db:up                 # Postgres container, waits for healthy
npm run db:migrate            # prisma migrate deploy (backend/.env DATABASE_URL)
npm run dev                   # backend + frontend + ai-service via concurrently
npm start                     # db:up + db:migrate + dev
npm run db:down

# accounts (password from a hidden prompt or stdin, never argv; ends that user's sessions)
npm --prefix backend run user:password -- --email <e>               # set a password (e.g. the pre-account dev user)
npm --prefix backend run user:password -- --email <e> --name <n>    # create the user if missing
npm --prefix backend run user:password -- --list                    # users, meeting counts, password set or not
# production image: node dist/lib/auth/cli.js --email <e>   (see deploy/README.md)

# verify (run before calling anything done)
npm run typecheck             # backend tsc (src + test) and frontend tsc -b
npm run lint                  # frontend eslint
npm test                      # backend vitest + ai-service pytest + scripts (node --test) + frontend vitest
npm run check:ownership       # changed files vs docs/process/OWNERSHIP.md (track branches)
npm run check                 # all of the above + frontend build
npm run test:desktop          # desktop-recorder pytest (not part of npm test)

# evaluation (w2-eval; eval/README.md). eval/ and e2e/ have their own package.json
npm run setup:eval            # once: tsx, vitest, typescript for eval/
npm run test:eval             # harness unit tests, no network (not part of npm test)
npm run eval                  # every case with data -> eval/reports/<date>.md + .json (Gemini cap 30)
npm run eval -- --cases smoke # 2 cases, about 6 Gemini requests
npm run eval:check            # latest report vs eval/baseline.json: exit 1 regressed, 2 inconclusive
npm run eval:accept -- --note "why"   # make the latest report the baseline, on purpose
npm run eval:import-corrections       # Correction rows -> proposed expectations (--write to save)
npm run eval:fetch-ami        # 5 AMI meetings, about 1 GB, gitignored (eval/data/ami/)
npm run eval:new-case -- <slug> --audio rec.wav --meeting <id>   # a case from your own recording
npm run eval:gen-long         # writes the generated 90-minute case to eval/.generated/
npm run setup:e2e             # once: Playwright + chromium (headless shell)
npm run test:e2e              # browser e2e with the API mocked in the page

# demo (w5-demo)
npm --prefix backend run demo:seed    # (re)seed the read-only demo account, no Gemini or Whisper calls
npm run screenshots                   # README images from the demo seed (needs npm run setup:e2e)
npm run readme:accuracy [-- --check]  # README accuracy table from the latest eval report

# parallel tracks
npm run worktree:env <track>  # ports, env files, database, install, migrate for a track worktree
npm run setup:light           # Node packages only (no Python / torch)
```

Per service: `npm --prefix backend run dev|test|typecheck|migrate|generate`,
`npm --prefix frontend run dev|build|lint|typecheck`,
`node scripts/ai-service.mjs dev|test|install|install:test`.
Install with `cd <pkg> && npm install`, never `npm --prefix <pkg> install`.
Run from a directory that has its own `package.json`, the `--prefix` form
adds the root package as a `file:..` dependency.

- The backend runs without the ai-service: everything except
  transcription works. The transcribe job retries with backoff (about
  2 minutes), then the meeting is FAILED with `[TRANSCRIBING/ASR_UNREACHABLE]`
  and `/transcribe` returns a 502 "The transcription service could not
  be reached. Check that it is running, then retry." (smoke-tested
  before Pair 4, not since).
- Background jobs need Postgres (pg-boss, the default). `JOBS_DRIVER=memory`
  runs them in-process instead, lost on restart.
- `npm run setup:ai` installs faster-whisper (no torch), with PyAV pinned
  `<19`, and sherpa-onnx for voice diarization. The speaker-embedding
  model (WeSpeaker ResNet34-LM, about 26 MB, CC BY 4.0) downloads on
  first use into `ai-service/diarization/.models/` (gitignored) and is
  checked against its SHA-256. For tests only, `npm run setup:ai:test` installs fastapi, httpx,
  python-multipart and pytest. The tests stub out `faster_whisper`.
  `npm run bench:asr` runs the transcription benchmark.
- `backend` runs `prisma generate` on `postinstall`. Run
  `npm --prefix backend run generate` after editing `schema.prisma`.
- New migration: `cd backend && npx prisma migrate dev --name <name>`.
  Commit the migration folder.

### Deploy

Production runs on one Linux host with
[`docker-compose.prod.yml`](docker-compose.prod.yml): Caddy (TLS, single
origin), web (nginx), backend, a one-shot `migrate` service that the
backend waits for, ai-service and Postgres. Secrets come only from
`deploy/.env` (copied from `deploy/.env.example`, ignored by git).
Hosting options, update, rollback and backups are in
[`deploy/README.md`](deploy/README.md), including the public demo
(`DEMO_MODE=true`, then `node dist/demo/seed.js` in the backend
container). Caddy adds the security headers. `.github/workflows/images.yml`
builds the three images on PRs that touch them (nothing is pushed), and
`release.yml` publishes the extension zip and desktop builds when a `v*`
tag is pushed.

### Environment variables

**Root `.env`** (docker compose only): `POSTGRES_PORT` (5433),
`POSTGRES_USER` (postgres), `POSTGRES_PASSWORD` (postgres), `POSTGRES_DB`
(ai_meeting_summarizer).

**`backend/.env`** (validated in `src/lib/env.ts`; a missing required value
fails at boot):

| Var | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **required** | `postgresql://postgres:postgres@localhost:5433/<db>` |
| `GEMINI_API_KEY` | **required** | |
| `NODE_ENV` | development | |
| `PORT` | 5000 | |
| `LOG_LEVEL` | debug (info in prod) | debug, info, warn or error |
| `GEMINI_MODEL` | gemini-flash-latest | summaries, diarization, chat |
| `GEMINI_CLEAN_MODEL` | gemini-flash-lite-latest | the summary pipeline's cheap CLEAN/CLASSIFY steps |
| `EMBEDDING_MODEL` | gemini-embedding-2 | |
| `EMBEDDING_DIMS` | 768 | stored per row; search filters on it |
| `AI_SERVICE_URL` | http://localhost:8000 | |
| `CORS_ORIGIN` | * | Credentialed CORS: `*` reflects the caller's origin (development); anything else is a comma-separated allow-list |
| `UPLOAD_DIR` | uploads/meetings | relative to backend/ |
| `LIVE_CHUNK_DIR` | uploads/live | |
| `MAX_UPLOAD_MB` | 500 | |
| `MAX_CHUNK_MB` | 25 | |
| `TRANSCRIPTION_TIMEOUT_MINUTES` | 15 | |
| `ROLLING_SUMMARY_MINUTES` | 7 | |
| `LIVE_SESSION_IDLE_MINUTES` | 10 | |
| `DEVICE_TOKEN` | unset | **Deprecated and ignored** (w4-acct). Recorders use per-user device tokens from the Devices page. Still parsed so an old `.env` loads; no longer required in production |
| `TRANSCRIPTION_PROVIDER` | local | `local` (ai-service) or `deepgram`; anything else fails at boot |
| `DEEPGRAM_API_KEY` | unset | required when the provider is `deepgram` (paid per audio minute) |
| `DEEPGRAM_MODEL` | nova-2 | |
| `JOBS_DRIVER` | pgboss | `pgboss` (durable, in Postgres; creates its own `pgboss` schema) or `memory` (in-process, lost on restart); anything else fails at boot. Always `memory` under `NODE_ENV=test` |
| `STORAGE_DRIVER` | local | `lib/storage` driver; only `local` exists, anything else fails at boot. Today it holds the pipeline's job artifacts; uploads still go to `UPLOAD_DIR` |
| `STORAGE_DIR` | uploads | root of local storage, relative to backend/ |
| `SESSION_SECRET` | unset (dev placeholder) | Signs the session cookie. **Required in production**, at least 32 characters (`openssl rand -hex 32`), or the backend refuses to boot. Unset in development: a fixed placeholder, with a warning |
| `SESSION_MAX_AGE_DAYS` | 30 | days a login lasts without activity (the cookie is rolling) |
| `AUTH_ALLOW_SIGNUP` | true (false in production) | `POST /api/auth/signup`; true/false, 1/0, yes/no or on/off, anything else fails at boot. Off: create accounts with `user:password` |
| `SMTP_HOST` | unset | "email this summary"; unset = email export off (503) |
| `SMTP_PORT` | 587 | |
| `SMTP_SECURE` | false | true = TLS from the start (port 465); false = STARTTLS |
| `SMTP_USER` | unset | auth is sent only when set |
| `SMTP_PASSWORD` | unset | |
| `SMTP_FROM` | Meeting Companion <no-reply@localhost> | |
| `RETENTION_CRON` | 17 * * * * | when the audio-retention job runs (cron, UTC; hourly) |
| `DIARIZATION_PROVIDER` | voice | `voice` (ai-service speaker embeddings, free; falls back to text when the ai-service has no model), `text` (Gemini infers turns from the conversation) or `deepgram` (paid per audio minute; needs `DEEPGRAM_API_KEY`, else boot fails); anything else fails at boot. Applies to uploads and live chunks |
| `ME_DISPLAY_NAME` | You | label for your own (mic channel) lines until renamed, used only without a meeting (eval). The account's display name from Settings takes precedence on every meeting path (w4-acct) |
| `DEMO_MODE` | false | w5-demo: shows "Try the demo" and enables `POST /api/demo/login` |
| `DEMO_SESSION_HOURS` | 2 | how long a demo sign-in lasts |
| `RATE_LIMIT_ENABLED` | true in production | per-client limits on `/api` |
| `RATE_LIMIT_PER_MINUTE` | 300 | requests per minute per user (or IP when signed out) |
| `RATE_LIMIT_HEAVY_PER_HOUR` | 60 | uploads, processing, chat and sign-ins per hour |
| `MAX_AUDIO_MINUTES` | 180 in production, 0 elsewhere | longest recording or live capture processed; 0 = no cap |
| `FFPROBE_PATH` | ffprobe | measures uploads for `MAX_AUDIO_MINUTES` |
| `DEMO_TTS` | auto | demo seed only: `auto`, `sapi`, `espeak` or `tones` |
| `FFMPEG_PATH` | ffmpeg | ffmpeg binary for live assembly (w3-jobs); on PATH by default. Without it the final pass is skipped and the live draft is summarized |

**`ai-service/.env`** (read by `scripts/ai-service.mjs`; shell values take
precedence): `AI_SERVICE_PORT` (8000), `WHISPER_MODEL` (small), `WHISPER_DEVICE`
(auto), `WHISPER_COMPUTE_TYPE` (int8 on CPU, float16 on CUDA),
`WHISPER_LANGUAGE` (empty = auto-detect). Speaker diarization (w2-spk,
`POST /diarize`): `DIARIZATION_ENGINE` (sherpa; `pyannote` is optional,
not installed, and needs torch, pyannote.audio and `HF_TOKEN` with the
model's licence accepted), `SPEAKER_EMBEDDING_MODEL`
(wespeaker_en_voxceleb_resnet34_LM, or a path to a local `.onnx`),
`SPEAKER_MODEL_DIR` (empty = `diarization/.models/`),
`SPEAKER_EMBEDDING_THREADS` (1), `HF_TOKEN` (empty).

**Evaluation** (`npm run eval`) reads `backend/.env` itself (shell values
win) and adds no variables of its own; `EVAL_NO_ENV_FILE=1` is a test
knob that skips the file.

**`frontend/.env.local`** (main checkout) or **`frontend/.env`** (written
by `worktree:env`): `VITE_API_URL` (http://localhost:5000/api)
and `FRONTEND_PORT` (5173, read by `vite.config.ts`). `VITE_DEVICE_TOKEN`
is no longer read (w4-acct): the web app signs in with the session
cookie.

### Parallel worktrees

Several Claude Code sessions run at the same time, each in its own
worktree (`claude --worktree <track>` → `.claude/worktrees/<track>`,
branch `worktree-<track>`), and each ends in one PR. **Every track follows
[`docs/process/PARALLEL.md`](docs/process/PARALLEL.md)** (rules and the finish protocol)
and may only change what [`docs/process/OWNERSHIP.md`](docs/process/OWNERSHIP.md) gives
it.

- **Start with `npm run worktree:env <track>`.** The track's slot in
  OWNERSHIP.md gives it ports (`base = 5100 + 10*slot`: backend `base`,
  frontend `base+1`, ai-service `base+2`). The script writes
  `backend/.env`, `frontend/.env` and `ai-service/.env` from the main
  checkout's env files with those ports and the database
  `ai_meeting_summarizer_<track>`, installs dependencies, then starts
  Postgres and migrates. `.worktreeinclude` copies the main checkout's
  `.env` files into new worktrees first.
- **Shared ai-service:** only tracks that own `ai-service/` files (w1-asr,
  w2-spk) run their own. The rest use the main checkout's on `:8000` and
  install with `setup:light` (no torch).
- **One shared Postgres container** (`docker-compose.yml` has a fixed
  `name:`), with one database per track. `prisma migrate deploy` creates a
  missing database (verified).
- `npm run check:ownership` and the CI `ownership` job fail a track PR
  that changes files outside its ownership, or any Prisma schema or
  migration (those belong on a `schema/<name>` branch).
- No absolute paths in code or scripts. Resolve paths relative to the
  file (see `scripts/*.mjs`) or to the service's working directory.

### Permissions (`.claude/settings.json`, committed)

These rules make the decision gates mechanical. Order is **deny, then ask,
then allow**: the first match wins, and a chained command (`&&`, `|`,
`;`) needs every part allowed.

- **Allowed without asking:**
  - read-only git
  - `git add`, `commit`, `switch`, `checkout -b`, `rebase origin/main`,
    `pull --ff-only`
  - read-only `gh pr` / `gh run`, and `gh pr create`
  - npm/npx test, lint, typecheck, build, install, dev and setup
  - `worktree:env`, `db:up`
  - `pip install`, `pytest`
  - `docker compose up`, `ps`, `logs`, `exec` and `config`
- **Ask:**
  - `git push`, `gh pr merge`, `gh api`, and `gh repo`, `release`,
    `secret` and `label` changes
  - `prisma migrate` / `db`, `db:migrate`
  - `docker compose down`, `docker volume` / `rm`, `dropdb`
  - `rm`, `rmdir`, `Remove-Item`
  - `git branch -d/-D`, `git worktree remove`, `git reset`, `restore`,
    `clean`
- **Denied:**
  - force-push in any form, including `+refspec` and
    `--force-with-lease`
  - any push to `main`, `git reset --hard`, deleting `main`
  - reading `.env` files (`Read(**/.env)` and `.env.local`), plus
    `cat`, `head`, `tail`, `grep`, `Get-Content` and `printenv` patterns
    for them

There are matching `PowerShell(...)` rules, because Bash rules don't
cover the PowerShell tool on Windows. **Caveat:** the shell rules for
`.env` are best-effort, since a command can be phrased in ways no pattern
predicts. Sandbox `denyRead`, which would enforce it, isn't available
here. Treat "never print `.env`" as a hard rule regardless. The
`worktree:env` script reads and writes `.env` files itself, which is
intended. Personal overrides go in `.claude/settings.local.json`
(gitignored).

## Code conventions (follow what is already there)

**Backend layering:** `routes/` → `controllers/` → `services/` →
`repositories/` → Prisma.

- Routes only wire paths to controllers. `routes/index.ts` is the single
  place the API is assembled.
- Controllers are wrapped in `asyncHandler`. They parse input with
  `utils/validate.ts` (`requireString`, `optionalString`, `requireParam`)
  and respond with `sendSuccess` (`{ success, message, data }`). They
  contain no business logic.
- Services hold the business logic and never import Express. Only
  repositories touch `prisma` (`lib/prisma.ts`, the single client).
- Types and schemas live in `types/` (for example `types/summary.ts` holds
  the TS interfaces, the Gemini `responseSchema` and the `toJsonValue`
  helpers for Prisma JSON).

**Errors:** throw `AppError` (`types/errors.ts`) or one of its helpers:
`NotFound`, `BadRequest`, and `UpstreamError` (502, for when Whisper or
Gemini fails). `toUserMessage` maps Prisma errors to safe messages, and
`middleware/error.middleware.ts` is the single error handler. Never send
upstream or Prisma error text to the client.

**Logging:** `logger` from `lib/logger.ts` writes structured JSON lines.
Each module creates a child logger,
`const log = logger.child({ module: "x.service" })`. Pass context as an
object and errors as the second argument to `log.error`. Sensitive keys
(token, apiKey, databaseUrl, ...) are redacted. Don't use bare
`console.log` in the backend.

**Gemini:** call it only through `lib/gemini.ts`:

- `getClient()` for the shared client
- wrap every call in `withRetry(() => ...)`, which retries 503s and 429s
- in `catch`, `throw toGeminiError(error, "<what failed>")`
- structured output always sets `responseMimeType: "application/json"`
  plus a `responseSchema`, and the result **is always validated**. It goes
  through `parseJsonResponse`, then a hand-written narrowing parser (see
  `parseStructuredSummary`, `asActionItems`). Never trust the model's
  JSON as typed.
- prompts forbid inventing facts, and relative dates are quoted as
  spoken, not resolved

**Config:** add new env vars to `lib/env.ts` (with a `required`,
`optional` or `asNumber` helper and a comment), to `.env.example` and to
the table above.

**Frontend:** pages live in `src/pages`, data fetching goes through
`src/api/api.ts` (`getData`, `postData`, `getErrorMessage`) and
`hooks/useFetch.ts`, and live capture is in `hooks/useLiveCapture.ts`.
Styling uses Tailwind 4. Keep `npm run lint` clean. Because of
react-refresh, a `.tsx` file exports only components; put contexts and
hooks in their own `.ts` files (see `lib/audio/`).

**Segments:** refer to segments by `TranscriptSegment.idx` everywhere,
never by array position (see Shared contracts).

**Comments:** the codebase explains *why* in doc comments above
non-obvious code. Keep doing that.

## Tests and fixtures

- Backend tests use vitest. They live in `backend/test/**/*.test.ts` or
  next to the code as `src/**/*.test.ts` (excluded from the build).
  `vitest.config.mts` supplies placeholder `DATABASE_URL` and
  `GEMINI_API_KEY`, sends uploads to a temp dir and blanks `DEVICE_TOKEN`,
  so modules that import `lib/env.ts` load without a real `.env`.
- **Accounts in tests:** `test/setup.auth.ts` (a `setupFiles` entry in
  `vitest.config.mts`) signs every request in as a default user
  (`TEST_USER`), so route tests written before accounts need no
  credentials. A request with `x-test-user: <id>` runs as that user,
  `x-test-user: anonymous` as nobody. It also makes every ownership
  lookup (`access.repository`) answer that user and resolves account
  settings to the server defaults. The only seam is
  `lib/auth/currentUser.ts` `resolveUser`; production code has no test
  bypass. Suites in `test/accounts/` override these mocks per test, or
  use the real modules (`auth.test.ts` drives the real cookie flow).
- **Isolation test:** `test/accounts/isolation.test.ts` lists every
  registered route and fails if one is not classified. A new route must
  be added there: another account's id is a 404, lists see only the
  caller's id, and no session is a 401.
  Unit tests must not hit the network or the database. Jobs always use
  the in-process memory driver under `NODE_ENV=test`, so job routes need
  no setup (see `test/jobs/`). Export pure
  helpers (like `parseSegments`) so they can be tested without either.
- Route-level tests use supertest on `createApp()`, with repositories and
  upstream services replaced by `vi.mock`. See `test/captureContract.test.ts`
  and its in-memory fakes in `test/helpers/liveFakes.ts`.
- `scripts/**/*.test.mjs` use `node --test` (`npm run test:scripts`), for
  example the ownership glob rules.
- `ai-service/tests/` (pytest) installs a fake `whisper` module, and the
  model is loaded lazily (`get_model()`), so `/health` never loads it.
  `ai-service/diarization/tests/` uses a fake engine and a fake
  `sherpa_onnx`, so no model is downloaded; run it with
  `python -m pytest diarization/tests`; `pytest.ini` collects it, so
  `npm run test:ai` and CI run it.
- Live jobs: `backend/test/` covers assembly (scripted, and real ffmpeg
  where it is installed), speaker carry-over, the evidence remap, a
  killed worker, a restart during the late wait and `/end` with the
  queue down, on the memory driver.
- `eval/test/` (`npm run test:eval`) and `e2e/` (`npm run test:e2e`) run
  in the `eval-tests.yml` workflow with zero Gemini requests.
  `eval-smoke.yml` (about 6 real requests, cap 8, no judge) runs only on
  pushes to main that change the summary pipeline, or by hand, and does
  not gate.
- `fixtures/transcripts/`: synthetic transcripts
  (`{speaker,text,startMs,endMs}[]`), each with an `*.expected.json`
  answer key (`mustAppear` / `mustNotAppear`, with evidence timestamps).
  `fixtures/transcripts/README.md` defines the format and matching rules.
  `backend/test/fixtures.test.ts` keeps the keys consistent with the
  transcripts. Use these for measuring accuracy.

## Rules

1. **Plan first, then wait for approval** before writing code (gate a).
2. **Never commit secrets, `.env` files, recordings or real
   transcripts.** That includes API keys, real `DATABASE_URL`s, anything
   under `uploads/` or `recordings/`, and audio or video files. The repo is
   public, so fixtures stay synthetic.
3. **Before calling anything done, run typecheck and tests** for what you
   touched (`npm run check` runs everything). Report failures honestly,
   with the output.
4. Each task gets its own branch and ends in a PR. Never push to `main`,
   never force-push, never merge your own PR.
5. Keep things worktree-friendly: ports and the database name come from
   env, and paths are relative.
6. Record non-obvious engineering choices in `docs/DECISIONS.md`.
   Parallel tracks write `docs/decisions/<track>.md` instead.
7. **`CLAUDE.md` and `docs/DECISIONS.md` are frozen while the waves run.**
   Only the integrator session changes them, after the engineer approves.
