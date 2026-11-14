# w2-eval decisions (evaluation, measured accuracy, regression gate)

How to run it: [`eval/README.md`](../../eval/README.md). The engineer's
choices at plan approval: D1 = A, D2 = A, D3 changed (see below).

## D1. Gemini budget: fixed mode, one batched judge request, cap 30

The baseline must fit 30 real Gemini requests. With the mode taken from
the answer key (no CLASSIFY request), a short case costs CLEAN + EXTRACT
+ VERIFY = 3, and the 90-minute case costs 2 CLEAN + 2 EXTRACT + REDUCE
+ VERIFY = 6 (asserted by `eval/test/long-case.test.ts`). The LLM judge
runs **once per run**, batched over all cases, on the flash-lite model:
7 × 3 + 6 + 1 = **28**, leaving 2 for retries.

- **Every attempt counts**, including retries inside `withRetry`.
  `GeminiMeter` refuses request 31 without sending it; its error message
  avoids the words `withRetry` treats as transient, so it is not retried.
- A case starts only if its estimate fits the remaining budget minus one
  request kept for the judge; otherwise it is `BUDGET_STOP`, which is not
  the same as `INFRA_ERROR`. A refusal in the middle of a case is also
  `BUDGET_STOP`, even when the pipeline swallowed it.
- Not measured, because it would cost 8 more requests: AUTO mode
  detection (CLASSIFY). Add it later with its own budget if wanted.
- AMI audio cases cost **0** Gemini requests: WER, DER (me vs others,
  from the channel) and "me" metrics need only the ai-service. DER for
  all speakers (`--diarize`) uses the exported `diarizeSegments`; with
  main's text-based diarizer that costs about one request per 120
  segments, so it is opt-in and outside the baseline.

## Counting without touching the pipeline

The pipeline is reached only through exported functions
(`runSummaryPipeline`, `chunkByTokenBudget`, `transcribeAudioDetailed`,
`diarizeSegments`, `withRetry`, `getClient`). The meter wraps
`generateContent` on the backend's single shared client at runtime, so
every pipeline request passes through it. Alternatives rejected: a test
hook in `lib/gemini.ts` (not ours to change), or a proxy server (more
moving parts). Risk: if `lib/gemini.ts` stops sharing one client, the
meter sees nothing. `eval/test/run.test.ts` would then fail, because it
asserts request counts through the real pipeline.

The call estimate mirrors two pipeline defaults (CLEAN batch 150, token
budget 12,000) in `eval/src/run.ts`. See the request to w1-sum below.

## Outages never read as low accuracy (INFRA_ERROR)

The pipeline swallows some failures on purpose: a failed CLEAN batch
counts as substantive, a failed VERIFY keeps the draft. During a 503
spike that would silently lower scores. The meter sees each attempt, and
a request whose **last attempt still failed** with 503, 429 or a network
error marks the case `INFRA_ERROR`, whether or not the pipeline threw.
Credentials errors and an unreachable ai-service count as infrastructure
too. Such a case is re-run once after `--retry-wait` (60 s) if the budget
covers it. `INFRA_ERROR` and `BUDGET_STOP` cases are left out of every
accuracy number and listed apart. `eval:check` exits 2 (inconclusive),
not 1, when more than 25% of cases are in that state. A `PIPELINE_ERROR`
(the pipeline itself failed) is scored as "nothing found", because that
is the pipeline's fault.

## Matching is strict and mostly deterministic

The README's matching rules are implemented as written: all match terms,
case-insensitive, same kind, one-to-one in key order. Owner must be
**equal** (not contained); a deadline needs the spoken phrase and, when
the key has `dueResolved`, the exact resolved date. The judge only sees
what string matching could not settle: unmatched expected items next to
unmatched produced items of the same kind, and produced items whose
content words are poorly supported by their cited lines. Its answers are
validated against what was offered. Without the judge (`--no-judge`, or
no budget left), the report says so, and hallucination counts trap hits
only, with "suspect" items counted separately.

Every `dueResolved` in the committed keys agrees with `lib/dates` for
the case's meeting start (tested), so a mismatch at run time is a
summary error, not a key error.

## Answer-key additions (backward compatible)

These fields are optional: `me`, `counts`, `mayAppear`, `dueResolved`,
the mode `general`, and the kinds `qa`, `concern`, `strength`,
`followUp`, `struggledWith` and `feedback`. `backend/test/fixtures.test.ts`
ignores them and still validates every key, including the five new
ones. `eval/test/fixtures-extra.test.ts` checks the new fields.

## The 90-minute case is generated

A ~5 KB template plus a seeded generator (`scripts/eval-gen-long.mjs`)
builds 274 segments (about 12,800 words, 90 minutes) deterministically,
with 12 planted items spread over both halves. Filler is tested never to
contain a match term or trap, so only planted lines can satisfy the key.
The output goes to the gitignored `eval/.generated/` when written to
disk; the harness builds it in memory.

## AMI

`scripts/fetch-ami.mjs` downloads 5 kick-off meetings from the AMI test
and dev sets (ES2004a, IS1009a, TS3003a, ES2011a, IS1008a): per-headset
WAVs from the AMI mirror and `ami_public_manual_1.6.2.zip` for word
timings. No account is needed; the licence is CC BY 4.0. It builds the
capture contract's stereo form with ffmpeg (left = Headset-0, the "me"
speaker; right = the other headsets mixed), writes `reference.json`, and
deletes the single-headset files. Everything is in the gitignored
`eval/data/ami/`. Download is about 1 GB in total; the script prints
real sizes. Whisper on that audio is a heavy step (shared ai-service,
about 1 GB RAM) and runs only in a granted slot.

## Separate packages

`eval/` and `e2e/` have their own `package.json` and lockfile, so tsx,
vitest and Playwright never enter the backend or frontend lockfiles, and
`setup:light` stays lean (`npm run setup:eval` / `setup:e2e` install
them). The harness runs TypeScript with tsx and imports backend sources
directly; its tests run in the new `eval-tests.yml` workflow (zero
Gemini requests), next to the e2e job.

## D2. e2e mocks the API in the browser

`e2e/` runs the real frontend (Vite dev server) in one headless chromium
and answers every `/api` request with `page.route`. It checks
upload → transcribe → summarize → meeting page, the request order and the
v2 summary rendering, plus an outage message. There is no backend, DB or
AI, so it costs about 300 MB of RAM. A full-stack e2e would need a way to
point Gemini at a stub (see requests).

## D3. Smoke eval: only when the pipeline changes

`.github/workflows/eval-smoke.yml` runs on push to main **only** when
w1-sum's pipeline files change (`backend/src/prompts/**`,
`backend/src/services/summary*`, `backend/src/services/w1-sum*`,
`backend/src/lib/dates/**`, `backend/src/types/summary.ts`) or the two
smoke fixtures change, plus `workflow_dispatch`. It never runs on PRs. It
makes about 6 requests (cap 8, no judge) and passes with a notice when
the `GEMINI_API_KEY` secret is absent. It publishes the report and does
not gate: two cases are not comparable to the 8-case baseline.

## Baseline

`eval/baseline.json` is a placeholder in the first PR. The first full
run (28 requests) happens after merge on `w2-eval/baseline`, in a heavy
slot, followed by `eval:accept`. Default tolerances (absolute): task
recall and precision 10 pt, hallucination and trap rate 5 pt, exam
recall 25 pt (one miss of two is a fail), date accuracy 10 pt, WER 3 pt,
DER 5 pt, "me" 5 pt.

## Requests for other tracks

- **w1-sum:** export the pipeline's `DEFAULT_CLEAN_BATCH` and
  `DEFAULT_TOKEN_BUDGET` (summary.service.ts), so the eval's call estimate
  cannot drift from them. Today they are mirrored in `eval/src/run.ts`.
- **Integrator:** add the eval commands to CLAUDE.md
  (`setup:eval`, `eval`, `eval:check`, `eval:accept`,
  `eval:import-corrections`, `eval:fetch-ami`, `eval:new-case`,
  `test:eval`, `setup:e2e`, `test:e2e`), and consider adding `test:eval`
  to `npm test` (it needs `setup:eval` first).
- **Later (optional):** a `GEMINI_BASE_URL` env hook in `lib/gemini.ts`
  would allow a full-stack e2e against a stub model.
