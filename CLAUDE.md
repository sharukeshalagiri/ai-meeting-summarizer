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
  (segment `startMs`).

The current code is a working prototype of upload and browser-tab capture.
Stereo channel separation, the desktop recorder, auth, jobs, CI and
evaluation do not exist yet.

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

### Live capture flow

```
Browser tab (useLiveCapture.ts: getDisplayMedia)  or  extension (tabCapture + offscreen doc)
  POST /api/live/sessions                       Meeting(source LIVE) + LiveSession
  every CHUNK_MS (20 s): POST /api/live/sessions/:id/chunks  (multipart "chunk", durationMs)
        Whisper with offset_ms = session elapsedMs -> diarize -> append segments
        rolling summary every ROLLING_SUMMARY_MINUTES (best effort)
        chunk file deleted after transcription
  POST /api/live/sessions/:id/end               final summary
  reapStaleSessions (every 5 min) ends sessions idle > LIVE_SESSION_IDLE_MINUTES
```

Search and Q&A: `GET /api/search` and `POST /api/chat` embed the query and
run cosine similarity in SQL over `SegmentEmbedding`. Analytics:
`GET /api/analytics`. Tasks: `GET/PATCH /api/action-items`. Every route
is assembled in `backend/src/routes/index.ts`.

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
`localhost:5000`. The extension cannot be loaded yet.

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
npm test                      # backend vitest + ai-service pytest
npm run check                 # all of the above + frontend build
```

Per service: `npm --prefix backend run dev|test|typecheck|migrate|generate`,
`npm --prefix frontend run dev|build|lint|typecheck`,
`node scripts/ai-service.mjs dev|test|install|install:test`.

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

**`ai-service/.env`** (read by `scripts/ai-service.mjs`; shell values take
precedence): `AI_SERVICE_PORT` (8000), `WHISPER_MODEL` (base).

**`frontend/.env.local`**: `VITE_API_URL` (http://localhost:5000/api),
`FRONTEND_PORT` (5173, read by `vite.config.ts`).

### Parallel worktrees

Several Claude Code sessions run at the same time in `git worktree`s, and
each one ends in a PR. To keep them from colliding:

- **One shared Postgres container.** `docker-compose.yml` has a fixed
  `name:`, so `npm run db:up` from any worktree reuses the same container.
  Isolate data by **database name** in each worktree's `DATABASE_URL`
  (e.g. `.../ai_meeting_summarizer_feat_auth`). `npm run db:migrate`
  (`prisma migrate deploy`) creates the database if it does not exist
  (verified against the compose container).
- **Different ports per worktree.** Set `PORT`, `AI_SERVICE_PORT` and
  `FRONTEND_PORT`, and point `AI_SERVICE_URL` and `VITE_API_URL` at them.
- Each worktree needs its own `npm run setup`, because `node_modules` and
  `.venv` are not shared. Copy the `.env` files in by hand; they are
  gitignored.
- No absolute paths in code or scripts. Resolve paths relative to the
  file (see `scripts/ai-service.mjs`) or to the service's working
  directory.

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
Styling uses Tailwind 4. Keep `npm run lint` clean.

**Comments:** the codebase explains *why* in doc comments above
non-obvious code. Keep doing that.

## Tests and fixtures

- `backend/test/*.test.ts` (vitest). `vitest.config.mts` supplies
  placeholder `DATABASE_URL` and `GEMINI_API_KEY`, so modules that import
  `lib/env.ts` load without a real `.env`. Unit tests must not hit the
  network or the database. Export pure helpers (like `parseSegments`) so
  they can be tested without the network or the database.
- `ai-service/tests/` (pytest) installs a fake `whisper` module, and the
  model is loaded lazily (`get_model()`), so `/health` never loads it.
- `fixtures/transcripts/`: synthetic transcripts
  (`{speaker,text,startMs,endMs}[]`), each with an `*.expected.json`
  answer key (`mustAppear` / `mustNotAppear`, with evidence timestamps).
  `fixtures/transcripts/README.md` defines the format and matching rules.
  `backend/test/fixtures.test.ts` keeps the keys consistent with the
  transcripts. Use these for measuring accuracy.

## Rules

1. **Plan first, then wait for approval** before writing code, unless the
   user explicitly says to go ahead.
2. **Never commit secrets, `.env` files or recordings.** That includes
   API keys, real `DATABASE_URL`s, anything under `uploads/` or
   `recordings/`, and audio or video files. Fixtures stay synthetic.
3. **Before calling anything done, run `npm run typecheck` and `npm test`**
   (and `npm run lint` plus a frontend build if the frontend changed).
   `npm run check` runs all of them. Report failures honestly.
4. Each task gets its own branch and ends in a PR. Don't push to `main`
   and don't merge your own PR.
5. Keep things worktree-friendly: ports and the database name come from
   env, and paths are relative.
6. Record non-obvious engineering choices in `docs/DECISIONS.md`.
