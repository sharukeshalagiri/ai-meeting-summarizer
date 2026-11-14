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
reserved schema, the UI contract, ownership rules and CI. Stereo channel
separation, the desktop recorder, auth, background jobs and evaluation do
not exist yet. They are the waves' work.

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
| `ai-service/` | FastAPI + openai-whisper (CPU) | 8000 | `AI_SERVICE_PORT` |
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
  POST /api/meetings/:id/transcribe
        speech.service -> ai-service POST /transcribe { file_path (absolute), offset_ms }
        parseSegments drops noSpeechProb > 0.75
        diarization.service (Gemini infers speakers from text)
        -> Transcript + TranscriptSegment rows, durationSec
  POST /api/meetings/:id/summarize
        summary.service (Gemini, SUMMARY_SCHEMA) -> parseStructuredSummary
        -> Summary (markdown + data JSON + sentiment), ActionItem rows
  POST /api/meetings/:id/index
        embedding.service -> SegmentEmbedding (float8[], unit-normalized)
```

`POST /api/meetings/:id/upload` runs the whole pipeline in one request.
**The ai-service reads the file by path**, so it must share a filesystem
with the backend.

### Live capture flow (capture contract)

Every recorder (extension, desktop recorder, web page, bot) uses the
**capture contract** in [`docs/CAPTURE_CONTRACT.md`](docs/CAPTURE_CONTRACT.md)
(types in `backend/src/types/capture.ts`):

```
Recorder (stereo: left = my mic, right = everyone else)
  Authorization: Bearer <DEVICE_TOKEN>      one middleware: middleware/deviceAuth.middleware.ts
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
  POST /api/live/sessions/:id/end                       final transcript + summary
  reapStaleSessions (every 5 min) ends sessions idle > LIVE_SESSION_IDLE_MINUTES
```

The current web page (`useLiveCapture.ts`) still uses the **legacy** form
of the chunk call: a `chunk` field with no `seq`. That path appends in
arrival order, takes offsets from the session clock and deletes the file.
It keeps working, but new recorders must use the contract.

Playback: `GET /api/meetings/:id/audio` streams the stored recording with
HTTP Range support (`res.sendFile`). There is no owner check until auth
exists. Live meetings have no single recording, so it returns 404 for
them.

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
  transcription works, and `/transcribe` returns a 502 with "Could not
  reach the transcription service" (smoke-tested).
- `npm run setup:ai` installs openai-whisper and torch, which is large. For
  tests only, `npm run setup:ai:test` installs fastapi, httpx and pytest.
  The tests stub out `whisper`.
- `backend` runs `prisma generate` on `postinstall`. Run
  `npm --prefix backend run generate` after editing `schema.prisma`.
- New migration: `cd backend && npx prisma migrate dev --name <name>`.
  Commit the migration folder.

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
| `EMBEDDING_MODEL` | gemini-embedding-2 | |
| `EMBEDDING_DIMS` | 768 | stored per row; search filters on it |
| `AI_SERVICE_URL` | http://localhost:8000 | |
| `CORS_ORIGIN` | * | |
| `UPLOAD_DIR` | uploads/meetings | relative to backend/ |
| `LIVE_CHUNK_DIR` | uploads/live | |
| `MAX_UPLOAD_MB` | 500 | |
| `MAX_CHUNK_MB` | 25 | |
| `TRANSCRIPTION_TIMEOUT_MINUTES` | 15 | |
| `ROLLING_SUMMARY_MINUTES` | 7 | |
| `LIVE_SESSION_IDLE_MINUTES` | 10 | |
| `DEVICE_TOKEN` | unset | Bearer token for `/api/live`. Unset in development: allowed, with a warning. **Required in production**, or the backend refuses to boot. |

**`ai-service/.env`** (read by `scripts/ai-service.mjs`; shell values take
precedence): `AI_SERVICE_PORT` (8000), `WHISPER_MODEL` (base).

**`frontend/.env.local`** (main checkout) or **`frontend/.env`** (written
by `worktree:env`): `VITE_API_URL` (http://localhost:5000/api),
`FRONTEND_PORT` (5173, read by `vite.config.ts`), and `VITE_DEVICE_TOKEN`
(sent as the Bearer token if set; it is visible in the bundle).

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
  `GEMINI_API_KEY`, sends uploads to a temp dir and leaves `DEVICE_TOKEN`
  unset, so modules that import `lib/env.ts` load without a real `.env`.
  Unit tests must not hit the network or the database. Export pure
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
