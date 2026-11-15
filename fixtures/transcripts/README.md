# Transcript fixtures

Synthetic transcripts with hand-written answer keys, used to measure
summary quality without real recordings. Nothing here comes from a real
meeting.

## Files

| Transcript | Answer key | Mode |
| --- | --- | --- |
| `project-meeting.json` | `project-meeting.expected.json` | project |
| `lecture.json` | `lecture.expected.json` | lecture |
| `interview-interviewer.json` | `interview-interviewer.expected.json` | interview (the user asks) |
| `interview-candidate.json` | `interview-candidate.expected.json` | interview (the user answers) |
| `one-on-one.json` | `one-on-one.expected.json` | one-on-one |
| `noisy-smalltalk.json` | `noisy-smalltalk.expected.json` | general |
| `no-tasks.json` | `no-tasks.expected.json` | general |

The 90-minute case is generated, not stored here: see
`scripts/eval-gen-long.mjs` and `eval/README.md`. Relative deadlines
are resolved against the meeting start in `eval/cases/index.json`
(Monday 2026-11-09, 15:00 UTC, America/New_York).

## Transcript format

A JSON array of segments in time order, the same shape the backend
stores as `TranscriptSegment` (minus ids):

```json
{ "speaker": "Priya", "text": "…", "startMs": 0, "endMs": 4000 }
```

Times are milliseconds from the start of the recording. Segments do not
overlap.

## Answer-key format

```jsonc
{
  "transcript": "project-meeting.json",
  "mode": "project",               // project | lecture | interview | one-on-one | general
  "me": "Dana",                     // optional: the recording user's speaker name
  "counts": { "actionItem": 0 },   // optional: exact number of produced items of a kind
  "mustAppear": [
    {
      "id": "task-search-endpoint", // stable name for reports
      "kind": "actionItem",          // see kinds below
      "match": ["endpoint"],         // every term must appear in the item text
      "owner": "Marcus",             // actionItem only; null = no owner stated
      "dueDate": "Friday",           // actionItem/homework/date; quoted as spoken, null = none
      "dueResolved": "2026-11-13",  // optional: the calendar date dueDate means
      "evidenceStartMs": [76200]     // startMs of the segment(s) that say it
    }
  ],
  "mayAppear": [],                   // optional: allowed but not required (neutral for precision)
  "mustNotAppear": [
    {
      "id": "smalltalk-rain",
      "kind": "any",                 // "any" = must not appear in any section
      "match": ["rain"],
      "reason": "Weekend small talk."
    }
  ]
}
```

**Kinds:** `actionItem`, `decision`, `openQuestion`, `date` (all modes);
`examTopic`, `definition`, `homework` (lecture mode); `qa`, `concern`,
`strength`, `followUp`, `struggledWith` (interview mode); `feedback`
(one-on-one mode). `eval/src/items.ts` maps each kind to its summary field.

**Matching rules** (implemented in `eval/src/match.ts`):

- An expected item is found when one produced item of the same kind
  contains every `match` term, case-insensitive.
- `owner` and `dueDate` must contain the expected value, case-insensitive.
  `null` means the summary must not invent one.
- Deadlines stay relative ("by Friday"), matching the summarizer's rule
  of never resolving relative dates.
- A produced item's citation is correct when it points at a segment
  whose `startMs` is in `evidenceStartMs`.
- A `mustNotAppear` entry fails if any produced item of that kind (or of
  any kind, for `"any"`) contains every `match` term.

`backend/test/fixtures.test.ts` checks that these files stay consistent:
times are ordered, evidence points at real segments, owners are real
speakers, every `match` term is actually in the transcript, and the counts
the fixtures promise (five tasks, three deadlines, and so on) hold.
