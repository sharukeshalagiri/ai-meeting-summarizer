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

- The live flow's end is on jobs now (part 2, below). Chunk
  transcription and rolling summaries still run in the chunk request,
  on purpose: the recorder needs the segments in the response.
- The worker runs in the API process. To scale out, run the same build
  with only `startJobs()` (no HTTP). pg-boss coordinates several
  workers by itself.
- Env vars: `JOBS_DRIVER` (pgboss | memory), `STORAGE_DRIVER` (local),
  `STORAGE_DIR` (uploads). Add them to the CLAUDE.md table.

# Part 2: the live flow on jobs

## Live assembly (`jobs/assemble.ts`, queue `live-assemble`, stage ASSEMBLING)

- **Decode each chunk to PCM, place it by `startOffsetMs`, encode once.**
  Each chunk is decoded on its own (`ffmpeg -> s16le, 16 kHz`) and
  written into one PCM stream at its offset; one ffmpeg encoder turns
  the stream into `recordings/<meetingId>/live.ogg` (Opus, 32 kb/s
  stereo, 24 kb/s mono), stored through `lib/storage` (atomic rename).
  Memory holds one decoded chunk at a time (about 2 MB for 30 s), and
  the command line never lists hundreds of inputs (a filter-graph
  concat would exceed Windows' 32 KB limit on a long meeting).
- **Gaps are padded with silence, never skipped.** A missing seq, a
  chunk whose file is gone (retention), or one that will not decode
  becomes silence of its own length. Skipping would shift everything
  after it, and the final pass relies on the recording keeping the
  draft's timeline exactly. Each slot is cut or padded to its exact
  length so encoder padding cannot drift over an hour. Overlapping
  chunks are cut at the next chunk's start. Chunks after the last
  usable one are dropped (the recording ends there). Everything is in
  `recordings/<meetingId>/manifest.json` (included, skipped with a
  reason, missingSeqs, silence spans).
- **Stereo only if every chunk is `stereo-mic-left`.** A mono chunk has
  no mic/others split to put on the channels, so a mixed session is
  assembled mono (and transcribed mono).
- **16 kHz:** Whisper resamples to it anyway; a one-hour stereo
  recording is about 15 MB.
- **ffmpeg runs in the backend** (`FFMPEG_PATH`, default `ffmpeg`), and
  this PR adds it to the backend image. Chunk files are kept after
  assembly (retention deletes them with the recording).

## The final pass (`origin: "live-final"`)

- `/end` writes the live draft as the transcript (as before), then
  queues `live-assemble`; it advances to the normal transcribe ->
  diarize -> clean -> summarize -> index chain on the recording, with
  the session's layout, hints and roster as ASR options.
- **Speakers carry over from the draft by time overlap**
  (`jobs/liveFinal.ts`). Each final segment takes the speaker text and
  speakerId of the draft segment it overlaps most on the same channel
  (at least 30% of its length). That keeps renames exactly as the user
  made them: the segment text already shows the new name, the
  speakerId points at the MANUAL profile, and the SPEAKER Correction
  still maps the old name at read time. Re-diarizing from scratch could
  give "Speaker 2" to a different voice and move the rename onto the
  wrong person. Only segments with no draft counterpart (audio from a
  chunk that failed live) go to `diarizeSegments` with the meeting's
  profiles, which never overwrites a MANUAL name.
- **Corrections are never deleted or rewritten** by the final pass.
- **idx:** the final segments are written with `replaceForMeeting`, so
  they are dense (0..n-1), like an upload; summary evidence, labels and
  the index are rebuilt by the following steps. Draft idx values
  (`seq * 1000 + i`) are gone after the pass. A late chunk arriving
  after it is inserted at its sparse idx as usual until the next pass
  replaces everything again. (A sparse-idx write would need a new
  `segment.repository` function; not worth it while the next pass
  rewrites them anyway.)
- **Everything persisted that names a draft idx** (audited for this PR):
  - *ActionItem.evidence*: re-pointed right after the final segments
    are written (`remapActionItemEvidence`, pure logic in
    `liveFinal.ts remapEvidence`). Each entry's moment is its own
    `startMs`, else the draft segment's start (read before the draft is
    replaced); it gets the final segment that contains that moment, or
    the nearest one, and keeps `startMs` so a later pass (late chunks)
    can remap again. This matters for human-reviewed items, which the
    summarize step keeps untouched (`keepIds`); the others are
    regenerated with fresh evidence anyway. Needs
    `actionItem.repository.updateEvidence` (ownership granted for it).
  - *Summary.data* evidence: regenerated by the summarize step.
  - *TranscriptSegment.speakerId*: re-linked by idx after the write
    (`assignSegments`); SpeakerProfile rows are untouched.
  - *SegmentEmbedding*: cascades with the old segments; the index job
    re-embeds the new ones.
  - *ChatMessage.citations*: store `segmentId`, `startMs`, text and the
    meeting, and the Ask page links by `?t=<startMs>`. The timeline is
    unchanged, so the links still land; `segmentId` goes stale but is
    only used as a React key. Left as is.
  - *Correction before/after* (SPEAKER `idx` lists): history and
    evaluation feedback, not navigation; the rename map uses the names.
    Left as is.
  - *RollingSummary.data*: no segment references.
- **An empty final transcript never replaces a draft with speech.**
- **Fallback:** if assembly, transcription or diarization of the final
  pass cannot complete (no usable chunk audio, no ffmpeg, ai-service
  down after its retries, a permanent error), `runStage` calls
  `keepLiveDraft` instead of marking the meeting FAILED: the draft is
  summarized from CLEAN with the note "The full recording could not be
  processed again, so the summary uses the live transcript." With no
  draft either, the meeting is NO_SPEECH.
- **Legacy web-page sessions** (no LiveChunk rows, chunk files deleted)
  keep the old behaviour: `/end` queues the summary of the draft.
- `GET /meetings/:id/audio` needed no change: `Meeting.audioPath` points
  at the assembled recording once ASSEMBLING finishes.

## Late chunks: a delayed `live-late` job

- A late chunk with speech queues `live-late` keyed by session, starting
  2 minutes later. While one waits, more sends are dropped (stately
  singleton). When it runs it compares now with the session's
  `lastChunkAt`: under 2 minutes of quiet it re-queues itself for the
  rest, so it is a true debounce on the last chunk; while a pipeline
  step runs for the meeting it waits another 2 minutes. Then it rebuilds
  the draft transcript (out of NO_SPEECH) and runs the **whole final
  pass again** (`origin: "late"`), so the late audio is in the
  recording, the transcript and the summary.
- It is a pg-boss job, so a restart during the wait no longer loses it
  (test: the waiting job survives a queue stop and a new queue on the
  same store runs it).
- The job is queued **before** the chunk is marked TRANSCRIBED: if
  queuing fails the chunk is FAILED and the recorder's retry schedules
  it again. A late chunk on an ended session answers 503 up front while
  the queue is down, before any work.

## The reaper: a scheduled `live-reap` job

- `*/5 * * * *` on both drivers, registered with the other schedules
  (`schedules: true`, never in tests). pg-boss runs it once per tick
  cluster-wide, so several backend processes no longer each sweep. The
  `setInterval` in `server.ts` is gone. While the queue is down nothing
  is reaped, which is right: ending a session then would only answer
  503 internally.

## `/end` while the queue is down: 503 before any write

- Chosen over "write, then let /retry recover": both recorders (the
  extension's pending-ends alarm and the desktop uploader) already retry
  `/end` on any 5xx and treat 200 as done. If `/end` wrote the
  transcript and ended the session before answering 503, the retry would
  get `alreadyEnded: true` and the recorder would stop, with no summary
  ever queued. Answering 503 first keeps the session ACTIVE, so the
  retry is a fresh, complete `/end`. `/end` is now in the 503 list with
  process, retry, events, summarize, resummarize and upload.
- The remaining window (the queue fails between the writes and the
  enqueue): `startLiveFinal` resets the stage to null on a failed
  enqueue, and a repeated `/end` on an ENDED session with
  `processingStage` null and nothing running queues the final pass
  then. So the recorder's retry recovers that case too.

## For the integrator (part 2)

- CLAUDE.md "Live capture flow": replace "rolling summary ... chunk file
  kept / POST /end final transcript, then queues the summarize job /
  reapStaleSessions (every 5 min)" with: `/end` -> draft transcript ->
  job `live-assemble` (ASSEMBLING) -> full pipeline on
  `recordings/<id>/live.ogg` -> draft replaced, speakers carried; late
  chunks -> `live-late` (2 min quiet) -> final pass again; reaper ->
  `live-reap` cron every 5 min. Remove the paragraph saying the live
  queues have no workers, and the Playback line saying live meetings
  404 (they play once assembled). Add `/end` and late chunks to "When
  the queue is down".
- Env var for the CLAUDE.md table: `FFMPEG_PATH` (ffmpeg).
- Prerequisites: ffmpeg on PATH is now used by the backend too, not only
  the ai-service.

