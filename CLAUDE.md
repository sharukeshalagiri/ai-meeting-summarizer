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

The current code is a working prototype of upload and browser-tab capture,
plus the shared foundation for parallel work: the capture contract, the
reserved schema, the UI contract, ownership rules and CI. Pair 1 has
added stereo-aware transcription with faster-whisper (w1-asr) and the
summary pipeline v2 (w1-sum), wired in by `chore/pair-1-wiring`. Pair 4
has added durable background jobs on pg-boss, with progress over SSE
(w3-jobs, wired in by `chore/pair-4-wiring`), and production Docker
images, a compose file and a deploy guide (w3-infra). Wave 4 has added
accounts (w4-acct): email + password sign-in with server-side sessions,
every query scoped by user, per-user device tokens for recorders,
settings, audio retention, exports and meeting series.

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
| `ai-service/` | FastAPI + faster-whisper (CPU int8 / CUDA float16) | 8000 | `AI_SERVICE_PORT` |
| PostgreSQL | `pgvector/pgvector:pg16` via `docker-compose.yml` | 5433 (host) | `POSTGRES_PORT` |
| `extension/` | Chrome MV3 (incomplete, see below) | — | — |

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
        diarization.service diarizeSegments
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
any stage. Reads still work. `GET /api/health` is always 200 and reports
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
        Whisper with offset = startOffsetMs -> diarize -> segments at idx = seq*1000 + i
        session.elapsedMs = max(elapsedMs, startOffsetMs + durationMs)
        rolling summary every ROLLING_SUMMARY_MINUTES (best effort); chunk file kept
  POST /api/live/sessions/:id/roster {participants[]}   -> LiveSession.roster (name hints)
  POST /api/live/sessions/:id/end                       final transcript, then queues the summarize job
  reapStaleSessions (every 5 min) ends sessions idle > LIVE_SESSION_IDLE_MINUTES
```

The rest of the live flow still runs in-process: chunk transcription,
rolling summaries and the reaper (a `setInterval` in `server.ts`). Only
the final summary is a durable job (`/end` calls the same
`startSummary` as `POST /summarize`). The queues `live-assemble`,
`live-late` and `live-reap` are created at boot but have no workers yet.

The current web page (`useLiveCapture.ts`) still uses the **legacy** form
of the chunk call: a `chunk` field with no `seq`. That path appends in
arrival order, takes offsets from the session clock and deletes the file.
It keeps working, but new recorders must use the contract.

Playback: `GET /api/meetings/:id/audio` streams the stored recording with
HTTP Range support (`res.sendFile`). It is owner-checked like every
`/meetings/:id` path (another account's meeting is a 404), and `<audio>`
sends the session cookie by itself. After the audio-retention job has
deleted a recording (`audioDeletedAt` set, `audioPath` cleared) it is a
404 too. Live meetings have no single recording, so it returns 404 for
them.

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
  corrections and `jumpToSegment`. Live idx values are sparse
  (`seq * 1000 + i`). See [`docs/SCHEMA_NOTES.md`](docs/SCHEMA_NOTES.md).
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
- **Provider types** (no implementations yet): `TranscriptionProvider` and
  `DiarizationProvider` in `backend/src/types/providers.ts`.

The reasons behind these choices (chunked Whisper instead of streaming,
text-based diarization, `float8[]` instead of pgvector, embedding
batching) are in **`docs/DECISIONS.md`**. Read it before changing any of
them, and add an entry when you make a decision like these.

### Extension status

`extension/` contains only `manifest.json`, `background.js` and
`shared.js`. The manifest references `popup.html`, `content.js`,
`offscreen.html` and `icons/`, which **do not exist**, and the comments
mention an `EXTENSION.md` that doesn't exist either. The API base is
hard-coded to `http://localhost:5000/api` (it can be overridden through
`chrome.storage.local.apiBase`), and `host_permissions` hard-codes
`localhost:5000`. The extension cannot be loaded yet. It still posts the
legacy chunk form; moving it to the capture contract is w1-ext's job.

## Setup and commands

Prerequisites: Node 22+, Python 3.10+, Docker (for Postgres), ffmpeg on
PATH (Whisper needs it to decode audio).

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
npm test                      # backend vitest + ai-service pytest + scripts (node --test)
npm run check:ownership       # changed files vs docs/OWNERSHIP.md (track branches)
npm run check                 # all of the above + frontend build

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
  `<19`. For tests only, `npm run setup:ai:test` installs fastapi, httpx,
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
[`deploy/README.md`](deploy/README.md). The images have not been built
in CI yet, and the release workflow is not merged.

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

**`ai-service/.env`** (read by `scripts/ai-service.mjs`; shell values take
precedence): `AI_SERVICE_PORT` (8000), `WHISPER_MODEL` (small), `WHISPER_DEVICE`
(auto), `WHISPER_COMPUTE_TYPE` (int8 on CPU, float16 on CUDA),
`WHISPER_LANGUAGE` (empty = auto-detect).

**`frontend/.env.local`** (main checkout) or **`frontend/.env`** (written
by `worktree:env`): `VITE_API_URL` (http://localhost:5000/api)
and `FRONTEND_PORT` (5173, read by `vite.config.ts`). `VITE_DEVICE_TOKEN`
is no longer read (w4-acct): the web app signs in with the session
cookie.

### Parallel worktrees

Several Claude Code sessions run at the same time, each in its own
worktree (`claude --worktree <track>` → `.claude/worktrees/<track>`,
branch `worktree-<track>`), and each ends in one PR. **Every track follows
[`docs/PARALLEL.md`](docs/PARALLEL.md)** (rules and the finish protocol)
and may only change what [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md) gives
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
  bypass. Suites in `test/w4-acct/` override these mocks per test, or
  use the real modules (`auth.test.ts` drives the real cookie flow).
- **Isolation test:** `test/w4-acct/isolation.test.ts` lists every
  registered route and fails if one is not classified. A new route must
  be added there: another account's id is a 404, lists see only the
  caller's id, and no session is a 401.
  Unit tests must not hit the network or the database. Jobs always use
  the in-process memory driver under `NODE_ENV=test`, so job routes need
  no setup (see `test/w3-jobs/`). Export pure
  helpers (like `parseSegments`) so they can be tested without either.
- Route-level tests use supertest on `createApp()`, with repositories and
  upstream services replaced by `vi.mock`. See `test/captureContract.test.ts`
  and its in-memory fakes in `test/helpers/liveFakes.ts`.
- `scripts/**/*.test.mjs` use `node --test` (`npm run test:scripts`), for
  example the ownership glob rules.
- `ai-service/tests/` (pytest) installs a fake `whisper` module, and the
  model is loaded lazily (`get_model()`), so `/health` never loads it.
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
