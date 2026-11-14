# w1-sum decisions (summary intelligence)

For the integrator to fold into `docs/DECISIONS.md`.

## Pipeline: CLASSIFY → CLEAN → EXTRACT (map-reduce) → VERIFY → finalize in code

- **CLASSIFY** runs only when the mode setting is `AUTO`. It reads the
  first 5 minutes (max 8 000 chars) with the cheap model and returns
  `{mode, confidence, reason}`; the guess is stored as
  `Summary.data.detectedMode` and shown next to the mode picker.
- **CLEAN** labels every segment (`substantive | small_talk | logistics |
  filler | off_topic`) with the cheap model (`GEMINI_CLEAN_MODEL`,
  default `gemini-flash-lite-latest`, decision D5) in batches of 150.
  It never deletes text. Unknown labels default to `substantive`
  ("when unsure, keep it"). Segments that already have a label are not
  re-labelled. Labels are handed to an injected
  `writeNoiseLabels(labels)` callback, so this service stays free of
  segment storage (D6).
- **EXTRACT** sees only substantive segments, chunked by an estimated
  token budget (12 000 tokens, ~4 chars/token). Several chunks are
  merged by a **REDUCE** call; one chunk skips it.
- **VERIFY** re-reads the draft against the cited lines, drops
  unsupported items, merges duplicates and sets confidence 0–1. If
  VERIFY fails, the draft is kept with every confidence capped at 0.5
  so every item shows "needs review".
- **Finalize in code**: evidence idx values not in the substantive set
  are dropped (an item left with no evidence is dropped), speaker and
  startMs are copied from the segment rows (never trusted from the
  model), lengths are capped (`SUMMARY_CAPS`, TL;DR ≤ 3 sentences,
  ≤ 7 key points), `needsReview = confidence < 0.6`
  (`REVIEW_CONFIDENCE_THRESHOLD`).
- Temperature 0 everywhere; calls are sequential (free-tier per-minute
  limits). Every response is validated by the hand-written parsers in
  `services/w1-sum.parsers.ts`.
- Alternatives considered: one big prompt (cheaper, but small talk
  leaked into tasks and evidence was unchecked); embeddings-based
  filtering instead of CLEAN (no labels a person can inspect).

## Prompts are versioned files

`backend/src/prompts/*.v1.ts` (and `modes/*.v1.ts`), registered in
`prompts/index.ts`. `Summary.data.prompts` records the `id.vN` of every
prompt that produced the summary, so evaluation can compare versions. A
new prompt version is a new file, never an edit of an old one.

## Dates are resolved by code

The model returns the deadline **as spoken** (`dueSpoken`).
`lib/dates` resolves it with chrono-node, anchored on the meeting start
(`startedAt ?? createdAt`) in the viewer's IANA timezone (sent by the
frontend; UTC when missing or invalid), forward-dated ("Friday" means
the next Friday). Anything chrono cannot resolve, or that is vague
("next sprint", "soon"), stays `null`. Models
are bad at calendar arithmetic and the answer depends on the timezone,
which the model does not know.

## Summary.data schema version 2

`schemaVersion: 2`, `mode`, `modeSetting`, `detectedMode`, `tldr`,
`keyPoints`, `decisions`, `actionItems`, `dates`, `openQuestions`,
`whoSaidWhat`, `glossary`, `nextSessionPrep`, `keywords`, `sentiment`,
`sections.{lecture|interview|project|oneOnOne}` (only the active mode's),
`prompts`, `stats`. Every item carries `evidence: {idx, speaker,
startMs}[]` (idx = `TranscriptSegment.idx`), `confidence`,
`needsReview`. Rows without `schemaVersion` are version 1 and still
render (the frontend keeps the old view for them). `toLegacyView()`
projects v2 onto `StructuredSummary` for code that reads v1.
`parseStructuredSummary`, `generateSummary` and `generateRollingSummary`
are unchanged in behaviour (analytics and live still use them).

## Mode choice and reviews are Corrections

This track does not own `meeting.repository.ts`, so `PATCH
/meetings/:id/mode` records a `MEETING_MODE` correction; the latest one
wins over `Meeting.mode`. Accept / edit / reject of an action item is an
`ACTION_ITEM` correction (before/after, evidence keeps idx) via
`correction.repository record()`. On re-summarize, accepted and edited
rows are kept untouched, and the original text of rejected or edited
tasks is never re-created. Completion state carries over by task text.

## Endpoints (`routes/w1-sum.routes.ts`, under `/api/meetings`)

- `GET /:id/summary-review` → `{modeSetting, summaryMode, detectedMode, actionItems}`
- `PATCH /:id/mode` `{mode}`
- `POST /:id/resummarize` `{mode?, timezone?}` (runs the v2 pipeline over stored segments)
- `POST /:id/action-items/:itemId/review` `{action: accept|edit|reject, task?, owner?, dueSpoken?, priority?, timezone?}`

## Frontend

`SummaryView` detects the version at runtime (its prop stays typed as
`StructuredSummary` because `MeetingDetails.tsx` is not ours) and reads
the meeting id from the route. Order: mode picker, TL;DR, tasks (with
review), deadlines, decisions, mode sections, then everything else in a
collapsed `<details>`. Evidence chips call `jumpToSegment(idx)`; when
`hasAudio` is false (live meetings) the same call only scrolls and
highlights, and the chip says "show in transcript". The Tasks page
sorts open → due date → undated and flags overdue items.

## Requests for other tracks

1. `backend/src/repositories/segment.repository.ts`: add
   `setNoiseLabels(meetingId, labels: {idx, label}[])` (update
   `TranscriptSegment.noiseLabel` by `(transcriptId, idx)`), then pass it
   as `writeNoiseLabels` from `w1-sum.service.resummarize` and the two
   call sites below.
2. `backend/src/services/meeting.service.ts:227` (upload `/summarize`):
   switch from `generateSummary` to `runSummaryPipeline` over the stored
   segments + `toJsonValueV2` + `toActionItemInputs` (see
   `w1-sum.service.resummarize`, which already does exactly this).
3. `backend/src/services/live.service.ts:469` (live `/end`): same switch
   for the final summary. Rolling summaries stay on
   `generateRollingSummary`.
4. `backend/src/repositories/meeting.repository.ts`: an
   `updateMode(id, mode)` so `PATCH /mode` can also write `Meeting.mode`
   (today the correction alone is the source of truth).
5. `frontend/src/types/meeting.ts`: `Summary.data` could be typed as
   `StructuredSummary | SummaryV2`; not required, `SummaryView` detects
   it at runtime.

## Real-model results (2026-11-14, gate D4)

Run once over the two synthetic fixtures with `modeSetting: AUTO`,
meeting start 2026-11-09 15:00 UTC, timezone America/New_York.
`gemini-flash-latest` (classify/extract/verify) and
`gemini-flash-lite-latest` (CLEAN). **14 Gemini calls in total**: 10 in
the first run (project-meeting 5 incl. one 503 retry; lecture 5 that
ended in a 503 "high demand" after retries) and 4 in a lecture-only
rerun.

| Fixture | Mode detected | mustAppear found | Wrong evidence | Wrong owner/date | mustNotAppear hits | Invalid evidence idx |
| --- | --- | --- | --- | --- | --- | --- |
| project-meeting | PROJECT (1.0) | 7 / 7 | 0 | 0 | 0 | 0 |
| lecture | LECTURE (1.0) | 4 / 4 | 0 | 0 | 0 | 0 |

- CLEAN kept 20 of 28 project segments and 17 of 21 lecture segments as
  substantive; nothing from the small talk reached the summary.
- Both lecturer-flagged exam questions were found (chaining vs open
  addressing; amortized cost of doubling).
- Project deadlines resolved in code: "by Friday" → 2026-11-13, "by the
  end of next week" → 2026-11-20, "tomorrow" → 2026-11-10; tasks with no
  spoken deadline stay null. No item fell below the review threshold.
- Latency was high (about 5 to 9 minutes per fixture) because of Gemini
  503 retries during a demand spike. That is why re-summarize is a
  10-minute request today; w3-jobs should move it to a background job.
