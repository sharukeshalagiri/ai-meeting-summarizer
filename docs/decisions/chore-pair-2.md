# chore/pair-2-followups: decisions

Follow-ups after Pair 2 (w1-ext, w1-desk). For the integrator to fold
into `docs/DECISIONS.md` / `CLAUDE.md`.

## D1. Late chunks: 24 h window, debounced re-summary

**Problem.** Recorders drain their queue before `/end`, but a network
drop, a laptop sleep or the idle reaper can end a session while chunks
are still queued. Before this change those chunks got 410 and were
dropped by the recorder, so the transcript lost its tail.

**Decision.** An ENDED session accepts new seqs for 24 h after
`LiveSession.endedAt` (constant `LATE_CHUNK_WINDOW_MS` in
`live.service.ts`). Order in `ingestContractChunk`: a transcribed seq
replays (any age), then 410 if older than 24 h, then the normal claim
(409, failed-retry, `idx = seq*1000 + i`). The session stays ENDED and
no rolling summary runs. A chunk that adds at least one segment calls
`scheduleResummary(sessionId)`: one in-memory timer per session, reset
by each new chunk, firing 2 min after the last one
(`LATE_RESUMMARY_DELAY_MS`). On fire it rebuilds the transcript text and
`durationSec` from the segments (the same `writeTranscript` step `/end`
uses), sets the meeting TRANSCRIBED and calls `startSummary`. If a
summary is still running for the meeting, it waits another 2 min. A
chunk claimed before `/end` that finishes after it also schedules one
(the session status is read after its segments are written).

- No schema change and no env vars (CLAUDE.md is frozen); both values
  are constants.
- Alternatives: reopening the session (would restart rolling summaries
  and the reaper clock for a meeting the user already ended);
  re-summarizing on every late chunk (a backlog of 20 chunks would cost
  20 Gemini runs).

**Known gap, for w3-jobs (pg-boss).** The debounce timer is in memory.
If the backend restarts during the 2 minutes, the pending re-summary is
lost and the summary stays stale until another late chunk arrives. The
late segments are stored, so a manual "Generate summary" fixes it. When
w3-jobs moves summaries to pg-boss, this should become a singleton job
keyed by session id with a 2 min start delay (`singletonKey` +
`startAfter`), which makes it durable and keeps the debounce.

## D2. NO_SPEECH instead of FAILED for empty sessions

A live session that ends (by `/end` or the reaper) with no segments
used to set the meeting FAILED, which offered a "Retry processing"
button that could never work (there is no recording to re-process).
Now the meeting gets `processingStage = "NO_SPEECH"` and status
`COMPLETED`: nothing failed, there was just nothing to summarize. The
frontend shows "No speech detected" (badge and a card, no retry). A
late chunk with speech clears the stage, sets TRANSCRIBED and
re-summarizes (D1).

`ProcessingStage` moved from `meeting.service.ts` to `types/meeting.ts`
(still re-exported by the service), so `live.service.ts` can use it and
tests that mock the service still get the constants.

## D3. Contract audio formats are tested

`docs/CAPTURE_CONTRACT.md` now names the accepted format: Opus, 48 kHz,
stereo, in `audio/webm` (extension) or `audio/ogg` (desktop).
`ai-service/tests/test_capture_formats.py` generates both with ffmpeg in
a temp dir and opens them with PyAV (`av.open`, what faster-whisper's
`decode_audio` uses), asserting 2 channels at 48 kHz on the stream and
on every decoded frame. It skips cleanly without ffmpeg, libopus or
PyAV. `av<19` is now in `requirements-dev.txt` and the CI job installs
ffmpeg.

## D4. CI

The frontend job runs `npm test` (vitest) and keeps its job name, so any
required-check settings still match. A new `desktop-recorder` job runs
`node desktop-recorder/run-tests.mjs` on Node 22 + Python 3.12.

Local note: on a Windows checkout with `core.autocrlf`,
`frontend/src/lib/capture/extensionCopy.test.ts` fails with
"Invalid or unexpected token" because `extension/scripts/build-capture.mjs`
gets a CRLF shebang. It passes on Linux CI. Not changed here.
