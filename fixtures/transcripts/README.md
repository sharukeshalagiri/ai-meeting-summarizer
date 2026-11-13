# Transcript fixtures

Synthetic transcripts with hand-written answer keys, used to measure
summary quality without real recordings. Nothing here comes from a real
meeting.

## Files

| Transcript | Answer key | Mode |
| --- | --- | --- |
| `project-meeting.json` | `project-meeting.expected.json` | project |
| `lecture.json` | `lecture.expected.json` | lecture |

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
  "mode": "project",               // project | lecture | interview | one-on-one
  "mustAppear": [
    {
      "id": "task-search-endpoint", // stable name for reports
      "kind": "actionItem",          // see kinds below
      "match": ["endpoint"],         // every term must appear in the item text
      "owner": "Marcus",             // actionItem only; null = no owner stated
      "dueDate": "Friday",           // actionItem/homework; quoted as spoken, null = none
      "evidenceStartMs": [76200]     // startMs of the segment(s) that say it
    }
  ],
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
`examTopic`, `definition`, `homework` (lecture mode).

**Matching rules** (for whatever evaluator is built later):

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
