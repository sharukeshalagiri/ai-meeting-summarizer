# w3-jobs decisions (durable background jobs)

For the integrator to fold into `docs/DECISIONS.md` (and the upload-flow
diagram in `CLAUDE.md`).

## pg-boss for the queue, behind a small interface

- **Why pg-boss.** It needs only the Postgres we already run: no Redis,
  no new container, no new paid service. Jobs survive a restart, retry
  with backoff, expire when a worker dies, and `singletonKey` gives us
  "one run per meeting" without our own locking. BullMQ would need
  Redis. A hand-rolled `jobs` table would mean writing the leasing,
  expiry and retry logic that pg-boss already has, plus a Prisma
  migration (gate c).
- **The `pgboss` schema.** pg-boss creates and migrates its own schema,
  `pgboss`, on first start (`PGBOSS_SCHEMA` in `jobs/pgBossQueue.ts`).
  Prisma does not know about it and never touches it, so this track
  needs **no Prisma migration**. `prisma migrate` ignores schemas it
  does not manage. The engineer confirmed this is outside gate (c).
  Prisma-only URL parameters (`schema`, `connection_limit`, ...) are
  removed from `DATABASE_URL` before pg-boss sees it.
- **`JobQueue` interface** (`jobs/queue.ts`). Services call `enqueue`,
  `isPipelineBusy` and `waitForJob` from `jobs/index.ts` and never see
  pg-boss. Two drivers implement it:
  - `pgboss`, the default and the only durable one.
  - `memory` (`JOBS_DRIVER=memory`, and always under `NODE_ENV=test`):
    in-process, with the same retry, singleton and expiry semantics, but
    lost on restart. Tests use it so they never need a database. It also
    works for a quick local run without Postgres jobs.
- **ESM.** pg-boss 10+ is ESM-only. Node 22.12+ can `require()` it from
  our CommonJS build. It is imported lazily, so tests and the memory
  driver never load it.

## The pipeline as jobs

`transcribe -> diarize -> clean -> summarize -> index` (`jobs/pipeline.ts`).
There is one queue per step, so each step has its own retry limit and
expiry (`jobs/definitions.ts`).

- **Stage at enqueue.** `processingStage` is written when a step's job
  is *queued*, so it means "waiting for or running this step". The page
  never shows a gap between steps, and a crashed worker leaves an
  accurate stage behind.
- **Idempotent steps.** Every write replaces rather than appends:
  segments are replaced for the meeting, the summary is upserted, and
  action items are replaced (keeping human-reviewed ones, per w1-sum).
  A step that runs twice gives the same result. That happens on a
  retry, or on a crash between commit and completion.
- **Artifacts between steps.** The Whisper output is stored as a
  storage artifact (`lib/storage`, key `storageKeys.asr`). That way a
  diarize failure does not mean transcribing again, and the existing
  transcript is untouched until diarize commits. The artifact is
  removed after the summary.
- **One run per meeting.** Jobs use `singletonKey = meetingId`. In
  addition, `startProcessing`, `startSummary` and `retryProcessing` do
  nothing while any pipeline job for the meeting is waiting or running
  (`isPipelineBusy`). A double-click, or two tabs, gets the current
  state back (still 202), not a second run.
- **Failures** (`jobs/errors.ts`). Each error is sorted into a kind
  (`RATE_LIMITED`, `AI_UNAVAILABLE`, `ASR_UNREACHABLE`,
  `DB_UNAVAILABLE`, `AI_AUTH`, `BAD_INPUT`, `INTERNAL`).
  - Transient kinds are retried by the queue with backoff. Meanwhile
    the meeting shows "Retrying automatically (attempt n of m)".
  - Permanent kinds, and transient ones that run out of attempts, set
    `processingStage = FAILED` with
    `processingError = "[STAGE/KIND] user-safe message"`. The text of
    upstream errors is never stored or shown.
  - If v2 summarization fails in the upload flow, the legacy summary is
    used and a note is recorded. A user's re-summarize has no fallback.
- **Retry and resume** (`POST /meetings/:id/retry`):
  - With segments, it resumes from CLEAN (clean, summarize, index).
    Whisper and diarization are not redone.
  - Without segments, it transcribes again (requires a recording).
  - Busy: it returns the current state.
- **Search indexing** runs after DONE and has no stage. A meeting is
  complete without it, and an indexing failure is only logged.

## Keeping the old endpoints

- `POST /transcribe` queues the pipeline and waits for the transcript,
  returning the same body as before. The summary carries on as a job.
- `POST /summarize` answers 202 and queues a summarize job.
- `POST /upload` attaches the file and queues the pipeline. Its
  response has `transcript: null`, `summary: null` and a `processing`
  state.
- `POST /resummarize` (w1-sum) queues a summarize job and waits up to
  4.5 minutes. After that it answers `{ queued: true, summary: null }`
  and the job carries on (contract in the PR body).

## New endpoints

- `POST /meetings/:id/process` (202): queues the whole pipeline for an
  uploaded recording.
- `POST /meetings/:id/retry` (202): see above.
- `GET /meetings/:id/events`, Server-Sent Events:
  - It sends the current `{ id, status, source, processingStage,
    processingProgress, processingError }`, then every change.
  - Once settled (no active stage and status not PROCESSING), it sends
    `event: end` and closes, so the browser does not reconnect in a
    loop.
  - Changes are pushed immediately for writes in this process
    (`progressBus`). Every 5 s the row is also re-read, so writes from
    another process still arrive.
  - A heartbeat comment every 25 s keeps proxies from closing the
    stream, and `X-Accel-Buffering: no` stops nginx from buffering it.
  - **SSE over WebSockets:** it is one-way and plain HTTP, and the
    browser reconnects by itself.
  - **Auth TODO (w4-acct):** EventSource cannot send headers. Scope the
    stream by cookie or a short-lived query token.
- `GET /api/health`: always 200, with `queue: "up" | "down"`.
  `GET /api/health/ready`: 503 while the queue is down. The root
  `GET /health` in `app.ts` stays a pure liveness probe. That file is
  shared, so it was left as it is.

## When the queue is down

- `server.ts` starts the queue after `listen`, so the API comes up even
  if the queue cannot. A failed start is logged at ERROR and retried
  every 30 s, and a half-started pg-boss is stopped.
- While the queue is down, every route that queues work answers **503
  "Background processing is unavailable right now. Try again shortly."**
  (`jobsUnavailable()`). It checks this before writing any stage, so no
  meeting is left showing a step that no job will ever run. The routes
  are process, retry, events, summarize, resummarize and upload.
  Reads still work.
- On shutdown, `stopJobs()` stops pg-boss gracefully (20 s), before
  Prisma disconnects. A job still running after that expires and is
  picked up by the next process.

## Frontend

- `components/progress/useMeetingProgress.ts` follows a run over SSE.
  It falls back to polling `GET /meetings/:id` every 5 s when the
  browser has no EventSource, the stream answers with an error status
  (503, 404), or three errors come in a row. It stops when the run
  settles.
- `NewMeeting.tsx`: create the meeting, then upload with real progress,
  then `POST /process` (202), then follow the steps. On DONE it
  navigates to the meeting. On a failure it shows the reason and offers
  Retry or Open the meeting. The user may leave the page, since the
  work is durable.
- `MeetingDetails.tsx`: the 5 s SUMMARIZING poll and its 20-minute
  "stuck" heuristic are gone (a durable job is not lost on restart).
  While a stage is active the page shows the step list. Retry is a
  single `POST /retry`.
- `SummaryView.tsx` is unchanged in this PR. The re-summarize "queued"
  response is handled by `chore/pair-4-wiring`.

## For the integrator

- The queue definitions `live-assemble`, `live-late` and `live-reap`
  exist, but the live flow (`live.service.ts`) still runs in-process
  (end of session, rolling summaries, the 5-minute reaper in
  `server.ts`). Moving it onto jobs is follow-up work. The queues are
  created at boot but have no workers yet.
- The worker runs in the API process. To scale out, run the same build
  with only `startJobs()` (no HTTP). pg-boss coordinates several
  workers by itself.
- Env vars: `JOBS_DRIVER` (pgboss | memory), `STORAGE_DRIVER` (local),
  `STORAGE_DIR` (uploads). Add them to the CLAUDE.md table.
