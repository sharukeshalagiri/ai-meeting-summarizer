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
