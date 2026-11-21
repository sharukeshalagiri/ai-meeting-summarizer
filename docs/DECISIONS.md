# Engineering decisions

Why the non-obvious choices were made, so the next person (or the
next me) does not have to re-derive them.

## Live capture uses MediaRecorder chunks, not streaming ASR

**Constraint:** live transcription with no paid API.

`getDisplayMedia({ audio: true })` can capture a browser tab's audio
with the user's permission, which covers Google Meet, Zoom Web, and
Teams Web without any platform integration. The question was what to
do with that stream.

Considered:

- **Web Speech API (`SpeechRecognition`)** — free and genuinely
  streaming, but Chrome-only, ships audio to Google's servers, and
  only transcribes the *microphone*, not a captured tab. It cannot
  hear the other participants, which is the entire point.
- **Streaming ASR service** (Deepgram, AssemblyAI) — the right tool,
  but paid.
- **Whisper on fixed chunks** — what we do. `MediaRecorder` emits a
  blob every N seconds, each is POSTed to the existing Whisper
  service, and its timestamps are shifted by the session's elapsed
  time so they land on the meeting's timeline.

The trade is latency: a segment appears one chunk-length after it was
spoken rather than word by word. In exchange the whole pipeline stays
free, self-hosted, and reuses the Whisper service that already
existed. Chunk length is a tunable in the client (`CHUNK_MS`).

Chunk files are deleted once transcribed. A two-hour meeting would
otherwise leave hundreds of fragments on disk, and the transcript is
the artifact worth keeping.

**Abandoned sessions:** a tab can close without reaching the stop
endpoint, which would strand a session as `ACTIVE` forever. A sweep
(`reapStaleSessions`, every 5 minutes) finalizes anything that has
stopped sending audio for `LIVE_SESSION_IDLE_MINUTES`.

**Update (w3-jobs part 2):** under the capture contract, chunk files are
kept and assembled into one recording at `/end`, and the sweep is the
`live-reap` cron job. See "Live assembly" and "Late chunks and the
reaper are jobs" below.

## Diarization is inferred from the transcript, not the audio

**Constraint:** speaker attribution with no paid API and no GPU.

Real diarization (pyannote.audio) separates speakers acoustically. It
also needs a gated Hugging Face model, a licence acceptance, and a GPU
to run at a tolerable speed on a long recording. That is a heavy
dependency for a project whose transcript is already being sent to
Gemini.

Instead, `diarization.service.ts` gives Gemini the numbered segments
and asks who is speaking, inferred from conversational cues: names
used in address, question-and-answer pairs, handovers, topic shifts.
Where a participant's name is spoken it is used as the label;
otherwise labels fall back to `Speaker 1`, `Speaker 2`.

This is a text-level approximation. It is good at "these are two
different people taking turns" and at picking up names that were said
out loud; it cannot distinguish two people who never address each
other by name and speak in a similar register. It degrades safely: an
unlabelled segment inherits the previous speaker, and a failed call
labels everything `Speaker 1` rather than losing the transcript.

Swapping in pyannote later means replacing this one service — nothing
above it knows how the labels were produced.

**Update (w2-spk):** this is now the `text` provider and the fallback.
The default for live chunks is voice diarization; see "Speakers by
voice" below. Uploads still use it.

## Vectors live in a `float8[]` column, not pgvector

The brief asked for pgvector. This deployment's PostgreSQL 17 does not
have it available:

```sql
SELECT * FROM pg_available_extensions WHERE name = 'vector';
-- (0 rows)
```

Installing it needs a server-side build or a package the host does not
offer, so `CREATE EXTENSION vector` cannot succeed here.

The store therefore keeps embeddings in `SegmentEmbedding.embedding`
as `float8[]` and computes cosine similarity in SQL. Vectors are
unit-normalized on write, so cosine similarity reduces to a dot
product:

```sql
SELECT COALESCE(SUM(a * b), 0)
FROM unnest(e."embedding", $query) AS t(a, b)
```

This is a sequential scan. At this scale — thousands of segments — it
runs in single-digit milliseconds, and it is exactly what pgvector
does without an index anyway. It stays in PostgreSQL, with no external
vector database, which was the actual requirement.

Migrating to pgvector when it is available means changing the column
type and the body of `embedding.repository.search`. Nothing above that
function knows the difference.

## Embeddings: batching and dimensions

Two things about `gemini-embedding-2` that cost time:

**Batching.** Passing `contents: string[]` looks like a batch but is
not — the SDK reads the array as the *parts of one document* and
returns a single vector. Every segment in the batch would silently
collapse into one embedding. Each text must be wrapped as its own
`Content`:

```ts
contents: texts.map((text) => ({ role: "user", parts: [{ text }] }))
```

`readEmbeddings` asserts the returned count matches the input count,
so a regression here fails loudly instead of corrupting the index.

**Dimensions.** The model returns 3072 floats per segment. That is a
lot of storage and arithmetic for a transcript line, so
`outputDimensionality` truncates to 768. Google requires re-
normalizing after truncation, which `normalize()` does anyway.

The width is recorded per row (`dims`) and searches filter on it, so
changing `EMBEDDING_DIMS` cannot silently compare vectors of different
widths — old rows are ignored until re-indexed.

**Task types.** Documents are embedded with `RETRIEVAL_DOCUMENT` and
queries with `RETRIEVAL_QUERY`. Gemini maps the two into deliberately
different regions; using one type for both measurably degrades
retrieval.

## Action items are rows, not just JSON

The structured summary already contains action items, so storing them
again in an `ActionItem` table is duplication. It is deliberate: tasks
are queried *across* meetings (open items by owner, completion rate)
and their status changes independently of the summary that produced
them. Leaving them in JSON would mean scanning every summary to render
a task board.

Re-summarizing replaces the rows, carrying over completion state by
matching on task text — the only stable identifier available, since
the model does not emit ids.

## Summaries stay backward compatible

`Summary.data` grew from five fields to eleven. Rather than migrate
the stored JSON, `parseStructuredSummary` treats every field beyond
the original five as optional and defaults it to empty. Rows written
before the expansion still render; they simply show empty sections.
The same function parses fresh model output and stored rows, so there
is one set of rules rather than two that can drift.

`sentiment` is duplicated into its own column because analytics groups
on it, and grouping inside a JSON blob means scanning every row.

## Whisper returns segments, and empty ones are dropped

The Python service now returns `segments` alongside `text`. Both are
kept: the flat text remains the summarization input for meetings with
no segments, while segments drive the reader, citations, and
embeddings.

Whisper emits filler over silence — "Thank you.", "Bye." — with a high
`no_speech_prob`. Those are dropped above a threshold (0.75) so they
do not pollute summaries or surface as search results.

## Capture contract: idempotent on (sessionId, seq), sparse segment idx

**Constraint:** four recorders (extension, desktop, web, bot) on flaky
networks must be able to retry and upload out of order without
duplicating or scrambling the transcript.

- A `LiveChunk` row is **claimed** on `@@unique([sessionId, seq])` before
  any work, so the database (not application locks) decides which of two
  concurrent uploads processes a chunk. The loser gets **409**, meaning
  "still processing, retry later". A transcribed chunk replays its stored
  response with `duplicate: true`, and a failed one is re-claimed.
- Segment timestamps come from the client's `startOffsetMs`, not from
  arrival order. Segment idx is `seq * 1000 + i`.

**Why sparse idx instead of renumbering:** renumbering a meeting's
segments every time a late chunk arrives would break every reference
already handed out (citations, `seg-<idx>` anchors, evidence). Sparse
idx is stable from the moment a segment is written, keeps ordering by seq,
and makes a retried chunk collide on the existing unique `(meetingId,
idx)` index instead of duplicating. The cost: idx is no longer a
position. Everything must refer to segments by idx (see
docs/SCHEMA_NOTES.md), and `seq` is capped at 2 147 482 to stay inside a
32-bit Int.

The legacy web page keeps its old path (no `seq`) so it doesn't break
until w1-ext moves it over.

**Update:** w1-ext moved the web page to the contract, so no client in
the repo sends the legacy form now; the backend still accepts it. Since
w3-jobs part 2, sparse idx holds during the call only: the live final
pass rewrites the transcript with dense idx and re-points kept evidence
by time (see "The live final pass" below).

## Device token instead of user auth, for now

Recorders need some authentication before user accounts exist. A single
shared `DEVICE_TOKEN`, checked in one middleware with a constant-time
compare, is enough for a personal deployment and is trivial for each
recorder to send. It is optional in development, so the web page works
with zero setup (a warning is logged), and required in production, where
the backend refuses to boot without it. When real auth lands, the same
middleware is the single place to swap.

## Parallel tracks: ownership file, port slots, shared ai-service

- `docs/OWNERSHIP.md` holds one machine-readable block that both
  `check-ownership.mjs` and `worktree-env.mjs` parse, so the rules and the
  documentation cannot drift apart.
- Ports come from a fixed per-track **slot** (`5100 + 10*slot`), not from
  the order tracks were started. A track's ports are therefore stable
  across machines and re-runs.
- Only tracks that own ai-service code run their own Whisper. Installing
  torch in every worktree costs gigabytes and minutes for no benefit.
- Prisma changes are allowed only on `schema/` branches, because two
  parallel migrations are the one conflict a rebase cannot fix safely.

## Transcription: faster-whisper, one pass per stereo channel (w1-asr)

Full log: [docs/decisions/w1-asr.md](decisions/w1-asr.md).

- **Engine:** faster-whisper (CTranslate2) replaced openai-whisper. It
  uses the same weights at about 4x the CPU speed with int8, needs no
  torch, and ships Silero VAD and word timestamps. whisper.cpp needs a
  native build on every OS, and WhisperX pulls torch back in.
  `requirements.txt` pins `av<19`, because PyAV 19 broke
  faster-whisper 1.2.1.
- **Stereo:** `stereo-mic-left` is transcribed one channel at a time,
  left as `channel: "mic"` and right as `"remote"`, then merged by start
  time. A silent channel is skipped. A mic segment that overlaps a
  remote segment and matches its text is dropped as echo.
- **Chunk boundaries (D1):** VAD runs inside each chunk, and repeated
  words at the edge between chunks are removed, using the previous
  chunk's trailing words. There is no audio overlap, so the capture
  contract did not change.
- **Hallucination guards** are named constants in
  `ai-service/asr/guards.py`: no speech, loops, repeated phrases and
  non-speech markers.
- **Providers:** `TRANSCRIPTION_PROVIDER` is `local` (the default) or
  `deepgram`. Deepgram is paid, so it is tested only with fake
  responses (D2).
- **Benchmark** (`npm run bench:asr`): 0.61× real time and a word error
  rate of 0 on an 11-second public-domain clip, with the small model on
  CPU. This is a smoke test, not an accuracy claim.

## Summaries: a staged pipeline, versioned prompts, dates resolved in code (w1-sum)

Full log: [docs/decisions/w1-sum.md](decisions/w1-sum.md).

- **Pipeline:** CLASSIFY (only in AUTO mode), then CLEAN, which labels
  every segment with a noise label using the cheap model
  (`GEMINI_CLEAN_MODEL`, D5) and never deletes text. EXTRACT reads only
  substantive segments and works map-reduce within a token budget.
  VERIFY drops unsupported items and sets a confidence. A final step in
  code checks evidence idx values, copies speaker and startMs from the
  segment rows and caps lengths. One big prompt let small talk leak
  into tasks.
- **Prompts are versioned files** (`backend/src/prompts/*.vN.ts`).
  `Summary.data.prompts` records which versions produced each summary.
  A new version is a new file, never an edit of an old one.
- **Dates:** the model quotes the deadline as spoken, and chrono-node
  resolves it from the meeting start in the viewer's timezone. Vague
  phrases stay null. Models are bad at calendar arithmetic, and they
  don't know the timezone.
- **`Summary.data` schema version 2** carries mode sections, and every
  item has `evidence: {idx, speaker, startMs}[]`, a confidence and
  `needsReview` (below 0.6). Rows without `schemaVersion` are version 1
  and still render.
- **Mode choice and task reviews** are stored as `Correction` rows
  through `record()`.
- **Real-model check (D4):** 14 Gemini calls on the two synthetic
  fixtures found 7/7 and 4/4 of the expected items, with no invalid
  evidence. Gemini 503s made each fixture take 5–9 minutes, which is
  why summarizing moved out of the HTTP request (see the wiring entry
  below).

## Summaries run in the background, in-process, until real jobs exist (Pair 1 wiring)

**Constraint:** with Gemini retrying 503s, the v2 pipeline took 5–9
minutes per meeting, longer than Node's default 5-minute
`requestTimeout`.

- `POST /summarize` returns 202, and live `/end` and `/upload` return
  immediately. `meeting.service.startSummary` claims the meeting
  synchronously, so two requests cannot start two runs. It sets
  `processingStage` SUMMARIZING and runs the summary in the same
  process. The outcome is written to the Meeting row as DONE or FAILED,
  with `processingProgress` and a user-safe `processingError`.
  `MeetingDetails` polls every 5 s and gives up after about 20 minutes,
  then offers a retry.
- **Fallback:** if the v2 pipeline throws, the legacy single-prompt
  `generateSummary` writes the summary instead, and
  `Summary.data.pipeline` records `"v2"` or `"legacy"`. No schema change
  was needed.
- **Cost, accepted for now:** a backend restart loses a run in
  progress. Pair 4 (w3-jobs) replaces this with pg-boss.
  `/resummarize` is still synchronous, and these paths resolve dates in
  UTC.
- **The rest of the wiring:** segments store `channel` and `words`.
  `setNoiseLabels` writes CLEAN's labels keyed by `(meetingId, idx)`.
  `Meeting.mode` is written by `PATCH /mode`. Live chunks pass the
  channel layout, the hints, the roster and the previous chunk's
  trailing words (by `seq - 1`, so out-of-order arrival still works) to
  the transcription provider.

## Background jobs: pg-boss in the Postgres we already run (w3-jobs)

Full log: [docs/decisions/w3-jobs.md](decisions/w3-jobs.md). This
replaces the in-process summary of the Pair 1 wiring entry above.

- **pg-boss over BullMQ or a hand-rolled table.** It needs only
  Postgres: no Redis, no extra container, no paid service. Jobs survive a
  restart, retry with backoff, and expire when a worker dies (a 30 s
  heartbeat lets a killed process's job be retried within about a
  minute). `singletonKey` gives one run per meeting without our own
  locking. BullMQ needs Redis. Our own `jobs` table would mean rewriting
  leasing, expiry and retries, plus a Prisma migration.
- **The `pgboss` schema is outside Prisma.** pg-boss creates and
  migrates it on first start (`PGBOSS_SCHEMA`). Prisma never manages it,
  so the track needed no migration; the engineer confirmed this is
  outside gate (c). Prisma-only URL parameters (`schema`,
  `connection_limit`, ...) are stripped from `DATABASE_URL` before
  pg-boss sees it.
- **A small `JobQueue` interface** (`jobs/queue.ts`). Services call
  `enqueue`, `isPipelineBusy` and `waitForJob` from `jobs/index.ts`, and
  nothing outside `src/jobs` imports pg-boss. pg-boss 10+ is ESM-only;
  Node 22.12+ can `require()` it from our CommonJS build, and it is
  loaded lazily.
- **An in-memory driver** (`JOBS_DRIVER=memory`, and always under
  `NODE_ENV=test`) has the same semantics in-process: stately singleton,
  retries with backoff, expiry. Tests never need a database, and a quick
  local run works without durable jobs. Its jobs are lost on restart, so
  it is not for production.
- **The worker runs in the API process.** Scaling out means running the
  same build with only `startJobs()`; pg-boss coordinates several
  workers by itself.

## The pipeline is one queue per step (w3-jobs)

`transcribe -> diarize -> clean -> summarize -> index`
(`jobs/pipeline.ts`), so each step has its own retry limit and expiry
(`jobs/definitions.ts`).

- **Stage at enqueue.** A step's `processingStage` is written when its
  job is *queued*, so it means "waiting for or running this step". The
  page never shows a gap between steps, and a crashed worker leaves an
  accurate stage behind. Indexing runs after DONE and has no stage: a
  meeting is complete without it, and its failure is only logged.
- **Idempotent steps.** Every write replaces rather than appends:
  segments are replaced, the summary is upserted, action items are
  replaced (v2 keeps human-reviewed ones). A step that runs twice, on a
  retry or after a crash between commit and completion, gives the same
  result.
- **One run per meeting:** `singletonKey = meetingId` on every job, plus
  a busy guard. `startProcessing`, `startSummary` and `retryProcessing`
  queue nothing while any pipeline job for the meeting is waiting or
  running (`isPipelineBusy`), and return the current state (still 202).
  The singleton is per queue, so on its own it would still let a
  summarize job be queued behind a running transcribe.
- **Whisper output is a storage artifact** (`artifacts/<id>/asr.json`),
  so a diarize failure does not mean transcribing again, and the
  existing transcript is untouched until diarize commits. If the
  artifact is missing, diarize queues transcribe again.
- **Failures are sorted into kinds** (`jobs/errors.ts`). Transient ones
  (`RATE_LIMITED`, `AI_UNAVAILABLE`, `ASR_UNREACHABLE`,
  `DB_UNAVAILABLE`) are retried with backoff while the meeting shows
  "Retrying automatically (attempt n of m)". Permanent ones (`AI_AUTH`,
  `BAD_INPUT`, `INTERNAL`), and transient ones out of attempts, set
  FAILED with `processingError = "[STAGE/KIND] user-safe message"`.
  Upstream error text is never stored or shown.
- **Fallback:** v2 failing in the upload flow still falls back to the
  legacy summary. A user's re-summarize has no fallback, since they
  asked for v2 in a chosen mode.
- **Retry and resume** (`POST /:id/retry`): with segments, resume from
  CLEAN, so Whisper and diarization are not redone; without them,
  transcribe again (needs a recording).

## Progress over SSE, with a polling fallback (w3-jobs)

- `GET /meetings/:id/events` sends the current progress row, then every
  change, then `event: end` once settled, and closes so the browser does
  not reconnect in a loop. Writes in this process are pushed at once
  (`progressBus`); the row is also re-read every 5 s, so writes from
  another process still arrive. A heartbeat every 25 s and
  `X-Accel-Buffering: no` keep proxies from closing or buffering it.
- **SSE over WebSockets:** progress is one-way, SSE is plain HTTP, and
  the browser reconnects by itself.
- `useMeetingProgress` falls back to polling `GET /meetings/:id` every
  5 s when there is no EventSource, the stream answers an error status
  (503, 404), or three errors come in a row. The 20-minute "stuck"
  heuristic is gone, since a durable job is not lost on restart.
- **Open:** EventSource cannot send headers, so the stream has no auth
  yet. w4-acct is to scope it by cookie or a short-lived query token.

## Synchronous endpoints are kept by waiting on jobs (w3-jobs, Pair 4 wiring)

Existing clients keep working, and the work is still durable.

- `POST /transcribe` queues the pipeline and waits for the transcript
  (up to `TRANSCRIPTION_TIMEOUT_MINUTES`, then 504).
- `POST /resummarize` waits up to `RESUMMARIZE_WAIT_MS` (4.5 min, below
  Node's 5-minute `requestTimeout`). After that it answers 200
  `{ queued: true, summary: null, actionItems: null, ... }` and the job
  carries on. The message is the same in both 200 cases, so clients
  check `data.queued`. `SummaryView` then follows the SSE stream.
- A re-summarize leaves `status` as it was (the old summary stays until
  the new one is saved), so its failure shows only as `processingStage`
  FAILED. Clients detect failure by stage, not status.
- `POST /upload` no longer returns a transcript (`transcript: null`,
  `summary: null`, plus `processing`).

## When the queue is down: 503, never a stuck stage (w3-jobs)

- `server.ts` starts the queue after `listen`, so the API comes up even
  when pg-boss cannot. A failed start is logged at ERROR and retried
  every 30 s; a half-started pg-boss is stopped.
- Every route that queues work answers **503** "Background processing is
  unavailable right now. Try again shortly." (`jobsUnavailable()`). It
  checks this before writing any stage, so no meeting shows a step that
  no job will run. Reads keep working.
- `GET /api/health` is always 200 with `queue: "up" | "down"`, and
  `GET /api/health/ready` is 503 while it is down, so a deployment can
  hold traffic without restarting a healthy process. The root
  `GET /health` stays pure liveness.
- On shutdown `stopJobs()` stops pg-boss gracefully (20 s) before Prisma
  disconnects. A job still running after that expires and is picked up
  by the next process.

## A `Storage` interface, local disk only (w3-jobs)

- `lib/storage` (`STORAGE_DRIVER=local`, root `STORAGE_DIR`) puts keys
  (relative POSIX paths, checked by `assertKey`) behind `put`, `get`,
  `exists`, `remove` and `localPath`. Writes go to a temp file and are
  renamed into place, so a crash never leaves a half-written key that a
  retried job would trust.
- `localPath` exists because the ai-service and ffmpeg read files by
  path. An S3-compatible driver would download to a temp file there.
- Today only the ASR artifact uses it. Uploads still go through multer
  to `UPLOAD_DIR`, and the live-recording keys are reserved.

## Production images and a one-host compose (w3-infra)

Full log: [docs/decisions/w3-infra.md](decisions/w3-infra.md).

- **Pinned, multi-stage, non-root images.** The backend uses
  `node:22.23.4-bookworm-slim` in both stages, because Prisma's engines
  target glibc and OpenSSL 3, and Alpine is a common source of "Query
  Engine not found". `tini` is PID 1. The ai-service uses
  `python:3.12.15-slim-bookworm` (manylinux wheels, no torch, no CUDA).
  The web image serves the Vite build on
  `nginxinc/nginx-unprivileged:1.30.6-alpine` (:8080).
- **The same uid (1000) and mount path (`/app/uploads`) for backend and
  ai-service.** They share the `uploads` volume, and the ai-service opens
  the backend's absolute path. Equal uids make the volume's ownership
  independent of which container mounts it first. The ai-service mounts
  it read-only.
- **The Whisper model is not baked in.** It downloads on first use into
  the `whisper_models` volume (`HF_HOME=/models`). CPU int8, one uvicorn
  worker, because the model is per process.
- **Migrations run in a one-shot `migrate` service**
  (`prisma migrate deploy`), and the backend waits for
  `service_completed_successfully`. An entrypoint step would run on
  every restart and race if scaled; a manual README step is easy to
  forget.
- **Caddy in front** gives automatic TLS and a single origin (`/api/*`
  and `/health` to the backend, the rest to web). The frontend is built
  with `VITE_API_URL=/api`: no CORS, no rebuild per domain. Caddy is the
  only service with published ports.
- **Secrets only through `${VAR:?}`** from `deploy/.env`, which the
  existing `**/.env` rule ignores (`.env.prod` would not be). A missing
  secret stops `up` with a clear error.
- **One host, not a PaaS split**, because the ai-service must share a
  filesystem with the backend (unless `TRANSCRIPTION_PROVIDER=deepgram`,
  which is paid). `deploy/README.md` compares a Hetzner CX23 with Oracle
  Always Free. The ai-service has a memory limit
  (`AI_SERVICE_MEMORY_LIMIT`, default 2g), so a runaway transcription
  cannot OOM Postgres.
- **Not yet verified:** the images have not been built, locally or in
  CI. The tag-triggered release workflow is not merged, because pushing
  it needs a token with the `workflow` scope.

## Accounts: Passport + express-session + argon2id, not Better Auth (w4-acct)

Full log: [docs/decisions/w4-acct.md](decisions/w4-acct.md).

- **Decision.** `passport-local` for email + password, `express-session`
  with our own store over the Prisma `Session` table
  (`lib/auth/sessionStore.ts`), and `@node-rs/argon2` (argon2id at the
  library defaults, the OWASP minimum: 19 MiB, t=2, p=1, encoded in the
  hash string).
- **Why not Better Auth.** It is ESM-only with no `require` condition in
  its `exports`, and the backend compiles to CommonJS with node10
  resolution, so its subpath imports (the Prisma adapter) don't resolve
  without changing the module system of the whole backend. It also
  brings its own user/account/session tables, which would mean
  reshaping `User`, and its handler works on Web `Request` objects
  beside Express rather than through it. Auth.js's Express adapter is
  experimental and built around OAuth. For one user with a password,
  none of that buys anything.
- **Why these.** Passport is the standard Express auth layer, CommonJS,
  and a Google login later is one more strategy. Passport 0.6+
  regenerates the session on login and logout (no session fixation).
  `@node-rs/argon2` ships prebuilt binaries for Windows and glibc/musl
  Linux, so no node-gyp on a laptop or in the image.
- **Server-side sessions** rather than a signed, self-contained cookie:
  logout deletes the row, and a password change ends every other session
  of that user (`Session.userId`), at once. Only the user id is stored in
  the session; each request re-reads the user.
- **Hardening:** one 401 text ("Wrong email or password.") for every
  failed login; an unknown email still runs an argon2 verify, so timing
  does not reveal accounts; an in-memory throttle allows 10 failures per
  email and per IP in 15 minutes, then 429 (a restart resets it, which is
  enough for one process); passwords are 10 to 256 characters;
  `GET /auth/me` never returns `passwordHash`.
- **Consequences.** Every request reads the session (one indexed lookup
  when a cookie is sent; none without one). Adding OAuth is a new
  strategy, not a new library.

## The session cookie (w4-acct)

- **Decision.** `ams.sid`, httpOnly, `SameSite=Lax`, `Secure` in
  production, rolling (`SESSION_MAX_AGE_DAYS`, default 30),
  `saveUninitialized: false` (no row and no cookie until login).
  `proxy: true` in production trusts Caddy's `X-Forwarded-Proto` for the
  Secure flag without changing app-wide `trust proxy`. Signed with
  `SESSION_SECRET`: required in production (at least 32 characters);
  development falls back to a fixed placeholder with a warning, so
  sessions survive ts-node-dev restarts.
- **Why.** httpOnly keeps the cookie from page scripts. Lax stops other
  sites from sending it on a POST; the dev frontend on another
  localhost port is the same site, so it still works there.
- **CORS** (`app.ts`): `credentials: true`, so the cookie crosses ports
  in development. A credentialed response may not say `*`, so
  `CORS_ORIGIN=*` now reflects the caller's origin, and anything else is
  a comma-separated allow-list. `Content-Disposition` is exposed for
  export downloads. Production is same-origin through Caddy.
- **No CSRF tokens.** SameSite=Lax already keeps the cookie off
  cross-site POSTs, and every state change is a POST, PUT, PATCH or
  DELETE. If the app ever moves to a different site than its API, this
  needs revisiting.
- **Consequences.** The frontend sends `withCredentials` (axios and
  EventSource) and the Live page fetches with `credentials: "include"`.
  The SSE progress stream is now authenticated by the cookie, which
  closes the "Open" item in the w3-jobs SSE entry above; `<audio>` sends
  it by itself.

## Every query is scoped by user; another account's row is a 404 (w4-acct)

- **Decision.** Defence in depth, in three layers:
  1. `routes/index.ts`: `/auth` and `/health` are public, `/live` has
     device auth, and everything else is behind `requireUser`.
     `router.use("/meetings/:id", requireMeetingAccess)` runs before
     every router that serves a meeting's sub-resources (meeting, w1-sum,
     w2-spk, w3-jobs, exports, series), so their controllers never run
     for someone else's meeting. `/live/sessions/:id` has the same guard
     (`requireLiveSessionAccess`), placed before multer, so a chunk for
     someone else's session is never written to disk.
  2. Lists take a `userId` down to SQL: meetings, analytics (every
     aggregate), action items, transcripts, series, devices, chat threads
     (`ChatMessage.userId`) and the raw search SQL.
  3. Single-row writes outside `/meetings/:id` check the owner first
     (`services/account/access.service.ts`, lookups in
     `repositories/access.repository.ts`): action item status, chat
     thread ids, transcripts, series, device revoke, and "Since last
     time" applying a change to an earlier meeting's task.
- **404, not 403.** A row of another account answers exactly like a
  missing one (same status, same message), so ids reveal nothing, not
  even that they exist.
- **The "first user" fallback is gone.** A meeting's owner is always the
  signed-in user or the device token's account; a `userId` in a request
  body is ignored.
- **Route-coverage test.** `test/w4-acct/isolation.test.ts` enumerates
  every registered route and fails when one is not classified, so a new
  endpoint cannot ship without an isolation check. For each id route,
  Alice with Bob's id gets 404; each list or create route reaches its
  repositories with Alice's id only; each non-public route without a
  session is 401. Removing the `/meetings/:id` guard fails 27 tests (the
  track's mutation check).
- **Consequences.** A new route under `/meetings/:id` is guarded for free;
  a new route anywhere else must be added to the isolation test's
  classification, and a list must pass the user id to its repository.

## Per-user device tokens replace DEVICE_TOKEN (w4-acct)

This replaces the "Device token instead of user auth, for now" entry
above.

- **Decision.** The `DeviceToken` table: `amsd_` + 32 random bytes
  (base64url), stored only as its SHA-256, with a display prefix
  (`amsd_` + 4 characters), `kind` (EXTENSION, DESKTOP, OTHER),
  `lastUsedAt` (written at most once a minute) and `revokedAt`. Created
  and revoked on the Devices page; the token is shown once; at most 20
  active per user.
- **Why a fast hash.** A 256-bit random token is not guessable, so a slow
  password hash buys nothing, and SHA-256 keeps the lookup one indexed
  equality on `tokenHash`.
- **Only `deviceAuth.middleware.ts` changed.** A Bearer token must belong
  to an account and not be revoked (checked on every request, no cache),
  and the request then runs as that account. A bad token is a 401 even
  when a session cookie is also present: an explicit credential that
  fails never falls back to another. With no header, the session is used
  (the web Live page).
- **Recorders are unchanged.** Both already send
  `Authorization: Bearer <their setting>`; the user pastes the new token
  into the same field. `test/w4-acct/devices.test.ts` replays both
  recorders' multipart uploads: after revoke, start, chunk, roster and
  end are all 401 and nothing is stored, and one account's token cannot
  upload into another's session (404).
- **Consequences.** `DEVICE_TOKEN` is deprecated and ignored (still
  parsed so an old `.env` loads), and no longer required in production;
  `SESSION_SECRET` is required instead. `VITE_DEVICE_TOKEN` is no longer
  read. One recorder can be revoked without touching the others, and
  every capture is owned by the account whose token sent it.

## Sign-up is off in production; a CLI sets passwords (w4-acct)

- **Decision.** `AUTH_ALLOW_SIGNUP` defaults to on outside production and
  off in production (`POST /auth/signup` then answers 403).
  `npm --prefix backend run user:password -- --email <e> [--name <n>]`
  sets a password for an existing user (such as the dev user who owns
  every pre-account meeting) or, with `--name`, creates one; `--list`
  shows users with their meeting count and whether a password is set.
  It ends that user's sessions.
- **Why.** A personal deployment on a public URL must not let strangers
  create accounts, and the meetings created before accounts already
  belong to a user who has no password.
- **The password is never in argv:** a hidden prompt (asked twice), or
  stdin when piped (a Windows BOM and trailing CRLF are stripped), so it
  stays out of shell history.
- **Consequences.** The code is in `src/lib/auth/cli.ts` (the script in
  `backend/scripts/set-password.ts` only imports it), so the production
  image, which has no ts-node, runs `node dist/lib/auth/cli.js`.

## Audio retention is a scheduled job (w4-acct)

- **Decision.** A per-user setting (`KEEP`, the default;
  `AFTER_PROCESSING`; `AFTER_DAYS` with N days), enforced by the
  `audio-retention` queue (`jobs/definitions.ts`, `jobs/worker.ts`). The
  server schedules it on `RETENTION_CRON` (default `17 * * * *`, hourly,
  UTC); the memory driver uses `*/60 * * * *` because it only parses
  `*/N`. `retryLimit: 0`: the next run picks up what is left. At most 200
  meetings per user per run.
- **What is deleted.** Only recordings: the upload file and every
  LiveChunk file of COMPLETED meetings with no stage running (DONE or
  none). Then `audioDeletedAt` is set and `audioPath` cleared. The
  transcript, summary, tasks and search index stay ("keep what was said,
  not the audio"). FAILED meetings keep their audio so they can be
  retried. LiveChunk rows stay, since they are the idempotency record.
- **Idempotent.** A missing file counts as deleted, and a meeting is
  marked only after all its files are gone, so a file that cannot be
  removed leaves its meeting for the next run.
- **Consequences.** After a sweep, playback answers 404 and
  MeetingDetails says the recording was removed. A retry can still resume
  from CLEAN, but transcribing that meeting again is no longer possible.

## Exports: one model, Markdown and PDF on the server (w4-acct)

- **Decision.** `services/export/exportModel.ts` builds a neutral
  document that `render.ts` turns into Markdown and into a PDF (pdfkit:
  pure JavaScript, built-in Helvetica, no headless browser).
  `GET /meetings/:id/export?format=json|md|pdf&transcript=1` (`json`
  backs "copy as Markdown"); `POST /meetings/:id/export/email` sends the
  Markdown body with the PDF and `.md` attached, to the owner's own
  address by default (at most 10 recipients), `replyTo` the owner.
- **Names, not ids.** Evidence becomes "Priya at 1:05", and the owner's
  display name replaces the default "You". No database id appears (a
  test asserts it).
- **Noise and rejected items are left out.** Segments the CLEAN pass
  labelled small_talk, logistics, filler or off_topic are dropped from
  the transcript; action items come from the ActionItem rows minus task
  texts a human rejected; dismissed "Since last time" items are dropped.
- **PDF on the server** so the Markdown and the PDF never disagree and
  the email can attach it. The cost: Helvetica covers only Latin-1, so
  other characters become `?` in the PDF; the Markdown keeps them.
- **SMTP only through `SMTP_*`.** With no `SMTP_HOST` the email endpoint
  answers 503 and nothing is sent. Tests install nodemailer's
  `jsonTransport` (`setTransportForTests`), so no real mail is ever sent.

## Series and "Since last time": suggestions, confirmed by the user (w4-acct)

- **Decision.** `Series` is unique per user and name; `Meeting.seriesId`
  is nullable (deleting a series sets it to null). For a meeting in a
  series with earlier open items, the w1-sum v2 summarize makes one
  Gemini call that judges up to 30 earlier PENDING items (newest first)
  as done, still open or not mentioned, against this transcript without
  noise segments (capped at 60k characters). The result is stored in
  `Summary.data.sinceLastTime`, so it needs no column.
- **Validated, never trusted.** `parseVerdicts` drops segment idx values
  that are not in the transcript, downgrades "done" without evidence to
  "still open", and makes a missing verdict "not mentioned". Evidence is
  by `TranscriptSegment.idx`. A failure only skips the section, never the
  summary; the legacy fallback summary has no section.
- **Nothing changes by itself.** A "done" item carries a suggested status
  (COMPLETED). `POST /meetings/:id/since-last-time/:actionItemId`
  `{apply|dismiss}`: `apply` checks the earlier item is the user's and
  marks it COMPLETED; either answer records a `SINCE_LAST_TIME`
  Correction (through `correction.repository` `record()`, with the
  evidence idx values) and is kept in the summary data, so a re-summarize
  keeps earlier dismissals and does not ask again.
- **Why.** A wrong "done" closes someone's task silently; a confirmed
  suggestion costs one click, and the Correction rows are labelled data
  for measuring the judge later.
- **Also.** `GET /series/:id/prep` gathers the open items across the
  series and the latest meeting's TL;DR, decisions, open questions,
  "prepare for next time" and "since last time". `seriesId` on
  `GET /search` and `POST /chat` limits retrieval to the series.

## Live assembly: one recording from the chunks, silence for gaps (w3-jobs)

Full log: [docs/decisions/w3-jobs.md](decisions/w3-jobs.md) (part 2).
This replaces "chunk files are deleted once transcribed" in the first
entry above: under the capture contract they are kept for assembly, and
the audio-retention job deletes them with the recording.

- **Decision.** At `/end`, job `live-assemble` (stage ASSEMBLING,
  `jobs/assemble.ts`) decodes each chunk on its own with ffmpeg
  (`FFMPEG_PATH`) to 16 kHz signed 16-bit PCM, writes it into one PCM
  stream at its `startOffsetMs`, and encodes that stream once to
  `recordings/<meetingId>/live.ogg` (Opus, 32 kb/s stereo, 24 kb/s mono)
  through `lib/storage`. `recordings/<meetingId>/manifest.json` lists the
  included chunks, the skipped ones with a reason, missing seqs and
  silent spans. `Meeting.audioPath` then points at the recording, so
  playback works for live meetings with no other change.
- **Gaps are silence of the same length, never skipped.** A missing
  seq, a chunk whose file is gone or one that will not decode becomes
  silence. Skipping would shift everything after it, and the final pass
  depends on the recording keeping the draft's timeline exactly. Each
  slot is cut or padded to its exact length so encoder padding cannot
  drift over an hour; overlapping chunks are cut at the next chunk's
  start.
- **Stereo only if every chunk is `stereo-mic-left`.** A mono chunk has
  no mic/others split to put on the channels, so a mixed session is
  assembled, and then transcribed, as mono.
- **Why one decoder per chunk and one encoder.** Memory holds one
  decoded chunk at a time (about 2 MB for 30 s), and the command line
  never lists hundreds of inputs: a filter-graph concat would pass
  Windows' 32 KB command-line limit on a long meeting. 16 kHz is what
  Whisper resamples to anyway, so a one-hour stereo recording is about
  15 MB.
- **Cost.** ffmpeg is now a backend dependency, not only the
  ai-service's; w3-jobs added it to the backend image.

## The live final pass replaces the draft, speakers carried by overlap (w3-jobs)

- **Decision.** After assembly, the normal upload chain (transcribe,
  diarize, clean, summarize, index) runs on the recording with the
  session's layout, hints and roster (`origin: "live-final"`). Its
  segments **replace** the live draft. Each final segment takes the
  speaker text and `speakerId` of the draft segment it overlaps most on
  the same channel, if that covers at least 30% of its length
  (`jobs/liveFinal.ts carrySpeakers`). Only segments with no draft
  counterpart (audio from a chunk that failed live) are diarized, with
  the meeting's profiles.
- **Why copy instead of re-diarizing.** The user has already seen, and
  may have renamed, the draft's speakers. Re-diarizing from scratch
  could give "Speaker 2" to another voice and move a rename onto the
  wrong person. Copying keeps renames exactly: the text shows the new
  name, `speakerId` points at the MANUAL profile, and the SPEAKER
  Correction still maps the old name. Corrections are never deleted or
  rewritten by the pass.
- **idx becomes dense.** The final segments are written with
  `replaceForMeeting`, so idx is 0..n-1 like an upload, and the draft's
  `seq * 1000 + i` values are gone. A late chunk after the pass is
  inserted at its sparse idx until the next pass replaces everything
  again. This refines the sparse-idx entry above: idx is stable during
  the call, not across a final pass.
- **Evidence is re-pointed by time.** The summarize step keeps
  human-reviewed action items untouched, so their evidence would name
  draft idx values and `jumpToSegment` would land nowhere. Right after
  the new segments are written, every action item's evidence is
  re-pointed (`remapEvidence`): its moment is the entry's own `startMs`,
  else the draft segment's start (read before the draft is replaced),
  and it gets the final segment that contains that moment, or the
  nearest. `startMs` is kept so a later pass can remap again. Audited and
  left alone: `Summary.data` evidence (regenerated), embeddings
  (cascade and re-index), chat citations (they link by `startMs`, and
  the timeline is unchanged), Correction `before`/`after` idx lists
  (history, not navigation).
- **Fallback: summarize the draft.** If assembly, transcription or
  diarization of the final pass cannot complete (no usable chunk audio,
  no ffmpeg, the ai-service down after its retries, a permanent error),
  `keepLiveDraft` summarizes the draft from CLEAN with the note "The full
  recording could not be processed again, so the summary uses the live
  transcript." instead of marking the meeting FAILED. With no draft
  either, the meeting is NO_SPEECH. An empty final transcript never
  replaces a draft with speech. The user already watched a transcript
  form during the call; losing it because the second pass failed would
  be worse than a summary of the draft.
- **Legacy sessions** (no `LiveChunk` rows; their files were deleted)
  keep the old behaviour: `/end` queues the summary of the draft.

## Late chunks and the reaper are jobs (w3-jobs)

This replaces the in-memory debounce of the Pair 2 follow-ups and the
`setInterval` reaper of the first entry above.

- **Late chunks: a delayed `live-late` job.** A chunk with speech for a
  session that ended less than 24 hours ago queues `live-late`, keyed by
  session, starting 2 minutes later; while one waits, more sends are
  dropped (singleton). When it runs it checks the session's
  `lastChunkAt`: under 2 minutes of quiet it re-queues itself for the
  rest, so it is a true debounce on the last chunk, and while a pipeline
  step runs for the meeting it waits another 2 minutes. Then it rebuilds
  the draft transcript (taking a NO_SPEECH meeting out of that state)
  and runs the **whole final pass again** (`origin: "late"`), so the late
  audio is in the recording, the transcript and the summary.
- **Why a job.** The old in-process timer was lost on a restart, and
  late chunks come exactly when things went wrong (a network drop, a
  laptop sleep). The job is queued **before** the chunk is marked
  TRANSCRIBED: if queuing fails, the chunk is FAILED and the recorder's
  retry schedules it again. A late chunk answers 503 up front while the
  queue is down.
- **The reaper: `live-reap`, cron `*/5 * * * *`.** Registered with the
  other schedules by the server only (never in tests). pg-boss runs it
  once per tick across processes, so several backends no longer each
  sweep. While the queue is down nothing is reaped, which is right:
  ending a session then would only hit the 503 below.

## `/end` answers 503 before any write while the queue is down (w3-jobs)

- **Decision.** `/end` checks the queue first and answers 503 without
  touching the session, chosen over "write, then let `/retry` recover".
- **Why.** Both recorders (the extension's pending-ends alarm and the
  desktop uploader) retry `/end` on any 5xx and treat 200 as done. If
  `/end` wrote the transcript and ended the session before answering
  503, the retry would get `alreadyEnded: true` and the recorder would
  stop with no summary ever queued. Answering 503 first keeps the
  session ACTIVE, so the retry is a fresh, complete `/end`.
- **The remaining window** (the queue fails between the writes and the
  enqueue): `startLiveFinal` resets the stage to null when the enqueue
  fails, and a repeated `/end` on an ENDED session with
  `processingStage` null and nothing running queues the final pass then.
  So the recorder's retry recovers that case too.

## Evaluation: a fixed Gemini budget, metered at the fetch level (w2-eval)

Full log: [docs/decisions/w2-eval.md](decisions/w2-eval.md). How to
run it: [eval/README.md](../eval/README.md).

- **Budget.** A full run must fit 30 real Gemini requests. The mode
  comes from the answer key (no CLASSIFY request), so a short case costs
  CLEAN + EXTRACT + VERIFY = 3, the generated 90-minute case 6, and the
  LLM judge runs **once per run**, batched over all cases, on the
  flash-lite model: 7 × 3 + 6 + 1 = 28. Every attempt counts, retries
  inside `withRetry` included; request 31 is refused before it is sent,
  with a message `withRetry` does not treat as transient. A case starts
  only if its estimate fits the rest of the budget minus one request
  kept for the judge; otherwise it is `BUDGET_STOP`. AMI audio cases
  (WER, DER me/others, "me" lines) cost 0 requests.
- **Metering the global `fetch`, not the client.** The harness reaches
  the pipeline only through exported functions and never changes it. The
  first meter wrapped the Gemini client the harness imported, but under
  tsx the harness (ESM) and the pipeline (CommonJS) loaded
  `lib/gemini.ts` as two module instances with two clients, so the meter
  saw only the judge's request (about 33 real attempts, cap not
  enforced); vitest resolves both to one instance, which is why the unit
  tests passed. Nothing from that run was accepted. The fix wraps the
  global `fetch` for the Gemini API host, which @google/genai looks up
  at call time, so every attempt from any module instance is seen.
  Requests are paced per model (`--rpm`, default 5) and aborted after
  `--request-timeout` (120 s). A run aborts (`MeterBlindError`) if a
  case produced a summary while the meter counted nothing, and
  `eval/test/cli.test.ts` runs the real CLI under tsx with a fake
  `fetch` and checks the count. Rejected: a test hook in `lib/gemini.ts`
  (not the track's file) and a proxy server (more moving parts). Risk:
  if the SDK stops using the global `fetch`, the guard and that test
  catch it.
- **Outages never read as low accuracy.** The pipeline swallows some
  failures on purpose (a failed CLEAN batch counts as substantive, a
  failed VERIFY keeps the draft). A request whose last attempt still
  failed with 503, 429, a quota error or a network error marks the case
  `INFRA_ERROR`, whether or not the pipeline threw; it is re-run once
  after `--retry-wait` if the budget allows. `INFRA_ERROR` and
  `BUDGET_STOP` cases are left out of every number, and `eval:check`
  exits 2 (inconclusive), not 1, when more than 25% of cases are in that
  state. A `PIPELINE_ERROR` scores as "nothing found".
- **Strict matching.** All match terms, same kind, one-to-one; the owner
  must be equal, and a deadline needs the spoken phrase and, when the
  key has `dueResolved`, the exact resolved date. The judge sees only
  what string matching could not settle, and its answers are validated
  against what it was offered.
- **The 90-minute case is generated** from a ~5 KB template by a seeded
  generator (`scripts/eval-gen-long.mjs`), so nothing large is
  committed; filler is tested never to contain a match term or trap.
- **Separate packages.** `eval/` and `e2e/` have their own
  `package.json` and lockfile, so tsx, vitest and Playwright stay out of
  the backend and frontend lockfiles and `setup:light` stays lean.
- **e2e mocks the API in the browser** (`page.route`): the real
  frontend in one headless chromium, about 300 MB of RAM, no backend,
  database or AI. A full-stack e2e would need a way to point Gemini at a
  stub.
- **The smoke eval runs only when the pipeline changes**
  (`eval-smoke.yml`: pushes to main touching w1-sum's pipeline files or
  the two smoke fixtures, or by hand; never on PRs). About 6 requests,
  cap 8, no judge; it passes with a notice when the `GEMINI_API_KEY`
  secret is absent and does not gate.
- **Baseline: pending (baseline not yet run).** `eval/baseline.json` is
  a placeholder. The free tier allows 20 gemini-flash-latest requests a
  day and a full run needs about 18 of them, so it must run on a fresh
  daily quota, followed by `eval:accept`. Default tolerances (absolute):
  task recall and precision 10 pt, hallucination and trap rate 5 pt,
  exam recall 25 pt, date accuracy 10 pt, WER 3 pt, DER 5 pt, "me" 5 pt.
  AMI WER and DER: pending (baseline not yet run).

## Speakers by voice: sherpa-onnx embeddings, clustered per chunk (w2-spk)

Full log: [docs/decisions/w2-spk.md](decisions/w2-spk.md). This makes
the text-based entry above ("Diarization is inferred from the
transcript") one provider of three, and the fallback.

- **Me = the mic channel, no model.** Every `mic` segment is the user:
  one SpeakerProfile with label `mic`, shown as the account's display
  name (Settings, w4-acct), else `ME_DISPLAY_NAME` ("You"). Mic echo of
  remote speech is already dropped by w1-asr.
- **Others: voice by default.** `DIARIZATION_PROVIDER` is `voice`
  (default), `text` (Gemini) or `deepgram` (paid), all behind
  `DiarizationProvider`. Voice calls the ai-service's `POST /diarize`:
  sherpa-onnx with the WeSpeaker ResNet34-LM model (256-d, CC BY 4.0,
  about 26 MB, downloaded on first use and checked against its SHA-256,
  never committed). Each remote segment is embedded in 3 s windows with
  a 1.5 s hop and averaged (segments under 0.5 s are skipped), then the
  chunk's segments are clustered (average-linkage cosine, merge at
  >= 0.5).
- **Why not pyannote.** pyannote 3.1 has the better published DER (AMI
  18.8%), but it needs torch, well over the 1 GB RAM budget on the
  development laptop, and a gated Hugging Face model (licence
  acceptance, `HF_TOKEN`: gate e). sherpa-onnx needs no torch: measured
  +52 MB after the model loads and a real-time factor of 0.047 on one
  CPU thread. pyannote remains an optional ai-service engine
  (`DIARIZATION_ENGINE=pyannote`, not installed). Deepgram returns no
  embeddings and restarts its speaker numbers every request, so across
  chunks it is only label-stable. Neither the paid nor the gated path
  was exercised.
- **Degrades, never fails a chunk.** Voice falls back to text when the
  ai-service is down or has no model (503), then to continuity, then to
  a single speaker.
- **Measured, with caveats.** A bench on the first 10 minutes of one AMI
  meeting (ES2004a Mix-Headset, 30 s chunks, reference turns as oracle
  segments so ASR errors are excluded) gave **22.4% segment-time speaker
  error** under the best 1:1 mapping. That has no overlap or
  missed-speech terms, so it is **not a DER**, and one 10-minute meeting
  is a sanity check, not a claim. It predicted 11 speakers for 4, and 5
  of 15 boundary cuts still split a speaker. WeSpeaker's published
  0.72% is a voice-verification EER and is not compared with any DER.
  The project's AMI DER: pending (baseline not yet run).
- **Scope today.** Voice diarization needs a meeting context, which only
  live chunks (and final-pass segments with no draft counterpart) pass.
  Uploads still use text labels plus the mic rule until the upload
  diarize job passes a context (w2-spk request 5).

## Stable speakers across chunks: matching to meeting profiles (w2-spk)

- **The problem.** Each live chunk was labelled in isolation, so one
  person could be "Speaker 2" in chunk n and "Priya" in chunk n+1
  (reproduced in `backend/test/w2-spk/chunkBoundary.test.ts`).
- **Decision.** `services/speakers/matcher.ts` (pure) matches each
  chunk cluster to the meeting's SpeakerProfile centroids, greedy and
  one-to-one, best pair first:
  - long clusters (>= 1 s of speech): match at cosine >=
    `MATCH_SIMILARITY` 0.55;
  - short clusters: >= `SHORT_MATCH_SIMILARITY` 0.40, else continue the
    previous chunk's last remote speaker if the cluster starts within
    `CONTINUITY_MS` 1.5 s of the chunk start (a sentence cut by the
    boundary);
  - no match: a new "Speaker N".
- **Centroid updates.** EMA `c' = normalize((1-a)c + a x)` with
  `a = clamp(ms / (ms + 20 s), 0.05, 0.5)`, so no count column and **no
  schema change**. A match moves the centroid only if it is at least
  `UPDATE_SIMILARITY` 0.65 **and** beats the second-best profile by
  `UPDATE_MARGIN` 0.05. A match between 0.55 and 0.65 keeps its label
  but leaves the centroid alone.
- **Why the 0.65 floor.** In the engineer's live test a second TTS voice
  (cosine 0.47-0.54 to the first) drifted onto the first speaker's
  profile: borderline matches pulled the centroid toward the other
  voice until one profile could match every voice. On the AMI bench the
  floor is neutral (22.4% and 5 of 15 splits at every value tried), so
  it is a guard against drift, not an accuracy gain.
- **Thresholds from a sweep.** 16 merge × match settings on the bench:
  with merge 0.3-0.5, match 0.55 was best (22.4-22.9%); lower match
  values merged different people (31-43%), 0.65 split more (25-28%), and
  merge 0.6 fragmented the clusters (24-32%).
- **Matching is serialised per meeting** with an in-memory lock, so two
  concurrent chunks never create duplicate profiles. That holds within
  one backend process.
- **Known gaps:** over-segmentation of short turns, the remaining
  boundary splits, and overlapping speakers (merged into one cluster).
  First fixes to try: a minimum cluster duration before creating a
  profile, and merging profiles whose centroids converge.

## Speaker names: two signals to apply, one to suggest; renames at read time (w2-spk)

- **Signals** (`services/speakers/names.ts`, regexes on the ASR text, no
  Gemini): `self_intro` ("I'm Priya", "my name is", "this is Priya",
  "Priya here"), `roster` (in `LiveSession.roster`) and `addressed`
  (another speaker says "thanks, Priya", "Priya, can you ...").
- **Applied automatically only with two signals:** self-introduction
  AND (roster OR addressed by another speaker). Never over a MANUAL
  rename or an existing name, never for the mic. A name claimed by two
  speakers, or the user's own name, is dropped. One signal is only a
  suggestion ("Priya?" chip, `POST /meetings/:id/speakers/:key/accept`).
- **Why two.** One regex hit is easy to fool ("I'm Frank about this",
  "I'm Sam's manager", "I'm sorry"; all tested), and a wrong name on
  every line of a speaker is worse than "Speaker 2". Two independent
  signals also work with no roster (the desktop recorder): an
  introduction plus being addressed.
- **Rename.** `PATCH /meetings/:id/speakers/:key {displayName}` sets the
  profile's name (source MANUAL), renames that speaker's segments and
  records a SPEAKER Correction through `record()` with the idx list.
- **Summaries are not rewritten.** w1-sum owns them, so
  `applySpeakerNames` (pure) projects current names at read time:
  evidence takes the segment's current speaker by idx, and `speaker`,
  `owner` and `assignedBy` strings equal to an old name are replaced;
  free text (TL;DR) is left alone. `withSpeakerNames` and
  `withOwnerNames` run on every read that returns summary evidence or
  task owners (meeting, summary, action items, exports), so a rename
  shows everywhere at once (wired in #32).

## Hide noise folds lines, it never removes them (w2-spk)

- **Decision.** `TranscriptView` has a "Hide noise" toggle, on by
  default and shown only when some segment is labelled. It folds
  segments whose `noiseLabel` (from the summary's CLEAN pass) is not
  `substantive`; unlabelled segments (null) stay visible.
- **Why folding.** The UI contract needs every `seg-<idx>` span in the
  DOM, so hidden segments render as `<span id="seg-<idx>" data-start-ms
  hidden>`, and a MutationObserver unfolds one when `jumpToSegment`
  highlights it. Evidence and citations that point at a folded line
  still land. CLEAN never deletes text either, so a wrong label costs a
  click, not a line.

## The demo account: a fixed address, no schema change (w5-demo)

- The demo account is the user `demo@example.com` (`src/demo/types.ts`).
  example.com is reserved, so no real person can own it. Recognising it
  by email needs no new column (no `schema/` branch) and works for the
  read-only check, which only has `req.user` (`{ id, name, email }`).
- It never has a password: the seed clears `passwordHash`, so the
  normal sign-in can't reach it. The only way in is
  `POST /api/demo/login`, which exists only with `DEMO_MODE=true` (off
  by default; 404 otherwise) and answers 503 with a hint when the demo
  was never seeded.
- passport regenerates the session on the demo sign-in (no fixation).
  The session lasts `DEMO_SESSION_HOURS` (default 2) instead of 30 days.
  The controller saves the session a second time so the store keeps the
  short `originalMaxAge`; without that the rolling cookie would grow
  back to 30 days on the next request (tested).

## Read-only is one deny-by-default middleware (w5-demo)

- `middleware/demo.middleware.ts` runs right after the session is read,
  before every router. For the demo account, every method except GET,
  HEAD and OPTIONS is a 403 with one message, apart from
  `POST /auth/logout` and `POST /auth/login`. Paths are compared lower
  case without a trailing slash (Express matches them that way), and a
  mismatch can only refuse, never allow.
- Rejected alternative: a list of forbidden routes. A route added later
  by any track would be writable by the demo until someone remembered
  the list. Deny by default covers uploads, deletes, renames, settings,
  device tokens, email exports, re-summarize, chat and live capture,
  and anything added later.
- The one GET that calls Gemini is `GET /search` (it embeds the
  query). For the demo account it is answered by a keyword search over
  its own segments (`services/w5-demo.service.ts`), mounted before the
  real handler; everyone else falls through. Same result shape, so the
  Ask page works. The demo has no embeddings, because making them would
  call Gemini.
- `test/w5-demo/readOnly.test.ts` lists every registered route (same
  method as w4-acct's isolation test) and sends every non-GET one as
  the demo account: all are 403 and no repository, embedding or Gemini
  call runs. A new mutating route anywhere is covered automatically.

## Seed data: hand-written v2 summaries over the synthetic fixtures (w5-demo)

- The three meetings (lecture, interview, project) use the transcripts
  of `fixtures/transcripts/` (a test checks them line for line), so the
  demo shows the same material the accuracy harness measures. The
  summaries are written by hand in `src/demo/content/*.ts`, in the
  pipeline's schemaVersion 2 shape, with mode sections, and respect the
  fixtures' answer keys: every must-appear item is there and cites an
  accepted segment, no must-not-appear trap is (tested).
- Evidence is written as segment idx numbers. `src/demo/build.ts` turns
  each into `{ idx, speaker, startMs }` from the real segment, the way
  VERIFY does, and throws on an idx that does not exist, so a chip can
  never point nowhere. Spoken dates are resolved by `lib/dates` against
  the meeting start, like the pipeline.
- Speakers follow w2-spk: the recording user is the `mic` profile and
  channel, others are `Speaker N` profiles with display names. Noise
  labels mark the small talk, asides and logistics, so the transcript's
  "Hide noise" works.
- The builder is pure (no env, Prisma or network): the seed, the tests
  and the screenshot runner share it.

## Audio: generated at seed time, never committed (w5-demo)

- `.gitignore` excludes every audio format and CLAUDE.md forbids
  committing audio, so `demo:seed` generates the recordings:
  - Windows: SAPI through one PowerShell process (built in, offline).
  - Linux/macOS: `espeak-ng` or `espeak` if installed.
  - Otherwise: a soft tone per speaker, as long as the line would take
    to say. Playable and deterministic, clearly not speech.
- Each line is spoken separately and the clips are laid end to end in
  the capture contract's stereo layout (left = mic, right = others). The
  segment times come from the clip lengths, so every chip seeks to where
  its line is actually spoken.
- ffmpeg compresses the WAV to Ogg Opus at 40 kb/s when available
  (about 0.6 MB for 2.5 minutes); otherwise the WAV is kept.
- Files go to `STORAGE_DIR/demo/<key>.ogg`, through `lib/storage`.
  Measured: the interview takes about 9 s to generate with SAPI.

## Public-instance limits (w5-demo)

- **Rate limits** (`middleware/rateLimit.middleware.ts`): in memory,
  fixed window, per user when signed in, else per client IP.
  - General: `RATE_LIMIT_PER_MINUTE` (300).
  - Heavy (uploads, processing, re-summarize, index, chat, email
    export, live session start, sign-in, sign-up, demo sign-in), on top
    of the general one: `RATE_LIMIT_HEAVY_PER_HOUR` (60).
  - `RATE_LIMIT_ENABLED` defaults to production only, so the existing
    route tests and local use are unaffected.
  - No dependency (express-rate-limit would add one to a package this
    track does not own). One backend process, so memory is enough; a
    restart only forgets counters.
  - Client IP: the app keeps `trust proxy` off. When the socket peer is
    a private or loopback address (Caddy on the compose network), the
    last `X-Forwarded-For` entry, the one Caddy appended, is the client.
    A direct internet peer is never private, so it cannot choose its
    key with a forged header.
- **Size and duration caps:** size stays `MAX_UPLOAD_MB` (multer).
  `MAX_AUDIO_MINUTES` (default 180 in production, 0 = off elsewhere):
  - `/transcribe`, `/process` and `/retry` measure the stored recording
    with ffprobe before work starts, and answer 413 when it is longer.
    If ffprobe fails, the request goes on and the failure is logged
    (fail open): the transcription timeout still bounds it, and a
    missing binary should not take processing down.
  - Live chunks are refused (413) once the session's `elapsedMs` reached
    the cap. That check runs before device auth (it is mounted ahead of
    the live router), so it can tell an unauthenticated caller that an
    unguessable session id exists and is long; nothing else.
  - `POST /:id/upload` stores and transcribes in one request, so there
    is no moment to measure the file. While a cap is set it answers 400
    and points to `/audio` + `/process` (what the web app uses). See the
    request below to lift this.
- **Retention:** the demo account's own audio is `KEEP` (the seed sets
  it), demo sessions expire after `DEMO_SESSION_HOURS` and the session
  store sweeps them, sign-up is off in production (w4-acct), and the
  w4-acct retention job applies to real accounts. Re-running `demo:seed`
  resets the demo account completely.

## Screenshots: the real frontend, the API mocked from the seed builder (w5-demo)

- `npm run screenshots` runs `e2e/screenshots/` (Playwright, one
  headless chromium, one Vite dev server) with the API answered in the
  browser from `buildDemoMeetings()` and tone audio. It writes
  `docs/images/*.png` (25–80 KB each, 1280×800, scale 1).
- A real local stack would need Docker, Postgres, the backend and the
  seed: about 2 GB more on a laptop with about 1 GB free. The mock
  serves the same data the seed writes, so the pictures match.
- Each step asserts what it photographs (the TL;DR, the exam section,
  the highlighted cited line), so a broken page fails instead of being
  photographed.

## README accuracy table: generated, with its source named (w5-demo)

- `scripts/readme-accuracy.mjs` rewrites the block between
  `<!-- accuracy:start -->` and `<!-- accuracy:end -->` from the newest
  `eval/reports/*.json` (by name: date, then run number; mtimes are not
  reliable after a checkout). With no report it says "Not yet measured"
  and prints no number (tested).
- The block names its source (`<!-- source: ... -->`). The test checks
  that the committed block is exactly the generator's output for that
  source, so a hand edit fails CI. It does not require the newest
  report: otherwise w5-acc committing a report would turn every PR red
  until someone regenerated the README (which only w5-demo owns).
  `--check` prints a note when a newer report exists.
- The metric labels are copied from `eval/src/report.ts`; a test parses
  that file and fails if they drift.

## Security headers at the proxy, no CSP yet (integration)

- **Decision.** Caddy sets HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, a referrer policy and a permissions policy
  (`microphone=(self)` for the web Live page) on every response, and
  drops the `Server` header. The deploy is one origin, so one place
  covers both the SPA and the API.
- **Rejected: helmet in Express.** It would cover only `/api`; the SPA
  is served by nginx. Doing it at the proxy keeps one list.
- **No Content-Security-Policy yet.** A wrong CSP breaks the app
  silently (audio from blob URLs, SSE, the extension's calls), and it
  needs a real browser pass on the deployed site first. Next step: ship
  it as `Content-Security-Policy-Report-Only`, watch the console, then
  enforce.

## Images are built in CI; releases come from tags (integration)

- **Decision.** `images.yml` builds the three production images on any
  PR that touches what goes into them, validates the compose file and
  the Caddyfile, and checks the backend image has ffmpeg, ffprobe,
  espeak-ng, the demo seed and the account CLI. Nothing is pushed: the
  deploy builds on the host (deploy/README.md), so there is no registry
  to secure or pay for.
- **Release.** `release.yml` runs on a `v*` tag: the extension zip
  (manifest version must match the tag, generated capture code must be
  current) and PyInstaller builds of the desktop recorder for Windows,
  macOS and Linux, published as one GitHub Release. Windows must build;
  macOS and Linux are untested, so their failure only adds a line to the
  release notes.
