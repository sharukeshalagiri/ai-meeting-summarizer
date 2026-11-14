# Evaluation

Measured accuracy of transcription, speaker attribution and summaries,
plus a regression gate. Owned by track w2-eval; decisions in
[`docs/decisions/w2-eval.md`](../docs/decisions/w2-eval.md).

```bash
npm run setup:eval                     # once: tsx, vitest, typescript for eval/
npm run eval                           # every case that has its data; writes eval/reports/<date>.md + .json
npm run eval -- --cases smoke          # project-meeting + no-tasks (about 6 Gemini requests)
npm run eval -- --cases lecture,no-tasks --no-judge
npm run eval -- --cases ami            # WER, DER, "me" on AMI audio: 0 Gemini requests, needs the ai-service
npm run eval -- --replay eval/runs/<stamp>.json   # re-score a stored run, 0 requests
npm run eval:check                     # latest report vs eval/baseline.json; exit 1 regressed, 2 inconclusive
npm run eval:accept -- --note "why"    # make the latest report the baseline, on purpose
npm run eval:import-corrections        # your review corrections -> proposed expectations (print only)
npm run eval:import-corrections -- --write
npm run eval:fetch-ami                 # download the AMI meetings (about 1 GB, gitignored)
npm run eval:new-case -- <slug> --audio rec.wav --meeting <id>   # a case for your own recording
npm run test:eval                      # unit tests, no network
```

Options of `npm run eval`: `--cases` (ids, or `smoke`, `synthetic`,
`transcript`, `ami`, `own`), `--cap N` (hard cap on Gemini requests,
default 30, every retry counts), `--no-judge`, `--diarize` (also DER for
all speakers with the exported `diarizeSegments`; costs Gemini requests
with main's text-based diarizer), `--retry-wait S` (wait before re-running
a case hit by an outage, default 60), `--title` (report name).

## Cases

| Case | Kind | What it tests |
| --- | --- | --- |
| project-meeting | synthetic | 5 tasks (3 dated), a decision, a question, small talk |
| lecture | synthetic | 2 exam flags, a definition, homework with a deadline |
| interview-interviewer | synthetic | the user is the interviewer: Q&A, a concern, the user's own task |
| interview-candidate | synthetic | the user is the candidate: a struggle, two promises, a date |
| one-on-one | synthetic | feedback, a decision, two commitments, a parked idea |
| noisy-smalltalk | synthetic | one real task buried in chatter, many traps |
| no-tasks | synthetic | a read-out with no tasks at all (precision) |
| long-90min | generated | 90 minutes, map-reduce over 2 chunks, items in both halves |
| ami-* (5) | AMI audio | WER, DER (me vs others), my lines labelled as me |
| own-* | your audio | whatever its `expected.json` / `reference.json` hold |

Synthetic cases live in `fixtures/transcripts/` (format in its README).
The 90-minute case is built by `scripts/eval-gen-long.mjs` from
`eval/cases/long-90min/template.json`. Run order and meeting start are
in `eval/cases/index.json`.

## Metrics

Accuracy is pooled over cases (micro averages). Only `OK` cases count;
`PIPELINE_ERROR` cases count as "nothing found"; `INFRA_ERROR` and
`BUDGET_STOP` cases are listed apart and never lower a number.

- **Task recall (headline: text + owner + date).** An expected task is
  found when a produced task contains every match term (or the judge
  pairs them), the owner is *equal* to the expected one, and the deadline
  phrase contains the spoken one *and* the resolved date equals
  `dueResolved`. Text-only recall is reported too.
- **Task precision.** Produced tasks that answer an expected (or
  `mayAppear`) task / all produced tasks.
- **Hallucination rate.** (items that trip a must-NOT-appear entry +
  items the judge found unsupported by the lines they cite) / all
  produced evidence-bearing items. Only low-support items (under 50% of
  their content words in the cited lines ±1) go to the judge.
- **must-NOT-appear hit rate.** Traps tripped / traps.
- **Exam-question recall.** Expected exam topics found among the
  lecturer-flagged exam questions.
- **Date accuracy.** Expected dated items (tasks, homework, dates)
  found with the right spoken phrase and resolved date; an invented
  deadline where the key says none is wrong.
- **TL;DR length.** Words and sentences.
- **Calls, cost, latency per audio minute.** From the meter; prices in
  `eval/pricing.json` (enter current prices before quoting a cost).
- **WER** (fillers dropped both sides), **DER me/others** (NIST style,
  10 ms frames, 250 ms collar, overlap scored, best label mapping),
  **my lines labelled as me** (my reference words inside a `mic`
  segment).

## Gemini budget and outages

All requests go through the backend's one Gemini client, which the
harness wraps (`src/meter.ts`): every attempt is counted, timed and
priced, and request N+1 past `--cap` is refused without being sent. A
case is only started when its estimated requests (CLEAN batches +
EXTRACT chunks + REDUCE + VERIFY) fit what is left, keeping one for the
judge. A request still failing on 503/429/network after its retries makes
the case `INFRA_ERROR`, even when the pipeline swallowed the failure; the
case is re-run once after `--retry-wait` if the budget allows. A refusal
mid-case makes it `BUDGET_STOP`.

Full run: 7 short cases × 3 requests + the 90-minute case's 6 + 1 judge
request = **28**, under the cap of 30.

## Data that never enters the repo

`eval/data/` (AMI), `eval/cases/own/` (your recordings), `eval/runs/`
(raw runs with summary text) and `eval/.generated/` are gitignored.
Committed reports hold metrics only for own cases. AMI Meeting Corpus:
https://groups.inf.ed.ac.uk/ami/corpus/, CC BY 4.0.
