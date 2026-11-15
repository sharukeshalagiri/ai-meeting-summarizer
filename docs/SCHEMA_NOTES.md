# Schema notes

What each field reserved for Waves 1–3 means and who fills it. The
migration `20261113063215_parallel_foundation` adds them all at once so
parallel tracks never need a schema change. Every new column is nullable
or has a default, so existing rows and code keep working.

Schema changes are gate (c). They go on a `schema/<name>` branch and need
the engineer's approval.

## Segment references: always `idx`

`TranscriptSegment.idx` is the **only** way to refer to a segment from
anywhere else: summary evidence, chat citations, corrections, the UI's
`id="seg-<idx>"` and `jumpToSegment(idx)`. **Never use an array
position.** For uploads idx is dense (0..n-1). For live capture under
the capture contract it is **sparse during the call**: `seq * 1000 + i`
(chunk 3's segments are 3000, 3001, …). So "the 5th segment" and
`idx = 5` are different things.

After the call, the **final pass** (w3-jobs: `/end` assembles the
recording and runs it through the upload pipeline) replaces the live
draft with segments numbered **densely** (0..n-1). Speakers carry over
from the draft. Kept action items have their evidence re-pointed to the
new idx **by time** (`jobs/liveFinal.ts` `remapEvidence`), and the
summary is regenerated from the new segments. If the final pass cannot
run, the draft and its sparse idx stay. Never keep an idx from a live
meeting across its final pass. Read it again from the stored rows.

## Meeting

| Field | Type | Meaning | Filled by |
| --- | --- | --- | --- |
| `mode` | String, default `AUTO` | `GENERAL` \| `LECTURE` \| `INTERVIEW` \| `PROJECT` \| `ONE_ON_ONE` \| `AUTO`. Chooses the summary flavour. `AUTO` lets the summarizer decide. | the recorder at session start; w1-sum reads it |
| `processingStage` | String? | Current background-job stage, e.g. `TRANSCRIBING`, `DIARIZING`, `SUMMARIZING`. | w3-jobs |
| `processingProgress` | Int? | 0–100 for the current stage. | w3-jobs |
| `processingError` | String? | User-safe message for the last failed stage. | w3-jobs |

pg-boss (Wave 3) keeps its own tables; nothing else is reserved for it.

## TranscriptSegment

| Field | Type | Meaning | Filled by |
| --- | --- | --- | --- |
| `channel` | String? | `"mic"` (left channel, the user) \| `"remote"` (right channel, everyone else) \| null for mono or older rows. | w1-asr |
| `noiseLabel` | String? | **Relevance label from the CLEAN pass**: `substantive` \| `small_talk` \| `logistics` \| `filler` \| `off_topic`. **Null = not yet classified** (not "clean"). The summarizer uses it to leave small talk, logistics and filler out of the summary. It does **not** describe non-speech audio: music and silence are dropped earlier by the ASR hallucination guards (e.g. the `noSpeechProb` filter) and never become segments. Still a plain string, so no migration is needed to start filling it. | the CLEAN pass (summary pipeline) |
| `words` | Json? | Word timings `[{ "w": "hello", "startMs": 1200, "endMs": 1450, "p": 0.93 }]`. | w1-asr |
| `speakerId` | String? → `SpeakerProfile.id` (on delete: set null) | The resolved speaker. `speaker` (text label) stays for display and older rows. | w2-spk |

## SpeakerProfile (new)

One distinct voice **within one meeting**, from diarization or a manual
edit. Roster names are **not** stored here (see `LiveSession.roster`).

| Field | Type | Meaning |
| --- | --- | --- |
| `meetingId` | → Meeting (cascade) | |
| `label` | String | Stable label within the meeting, e.g. `Speaker 1`, `mic`. Unique per meeting. |
| `displayName` | String? | Human name once known (inferred, from the roster, or entered). |
| `centroid` | Float[], default `[]` | Mean voice embedding for acoustic matching. Empty for text-based diarization. |
| `source` | String, default `DIARIZATION` | `DIARIZATION` \| `MANUAL` \| `ENROLLED`. |

Filled by w2-spk.

## Correction (new)

A user's fix to model output. It is kept as feedback for evaluation
(w2-eval) and so re-processing doesn't overwrite human edits. Write it
through `backend/src/repositories/correction.repository.ts` `record()`.

| Field | Type | Meaning |
| --- | --- | --- |
| `meetingId` | → Meeting (cascade) | |
| `kind` | String | `SPEAKER`, `TRANSCRIPT_TEXT`, `ACTION_ITEM`, `SUMMARY_ITEM`, … |
| `targetId` | String? | Row id of what was corrected, or a segment idx as a string. Optional. |
| `before` / `after` | Json | The value before and after. Segment references inside use `idx`. |
| `createdAt` | DateTime | |

## ActionItem

| Field | Type | Meaning | Filled by |
| --- | --- | --- | --- |
| `dueSpoken` | String? | Deadline exactly as spoken ("by Friday"). `dueDate` may later hold a resolved date. | w1-sum |
| `assignedBy` | String? | Who handed the task out, when it isn't the owner. | w1-sum |
| `confidence` | Float? | 0..1 model confidence. | w1-sum |
| `evidence` | Json? | `[{ "idx": 1003, "quote": "I'll have it by Friday" }]`, using **TranscriptSegment.idx**. | w1-sum |
| `needsReview` | Boolean, default false | Show as "please confirm" instead of trusting it. | w1-sum |

## LiveSession

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | String? | `EXTENSION` \| `DESKTOP` \| `WEB` \| `BOT`. Null for sessions created before the contract. |
| `hints` | String[], default `[]` | Context the recorder sent at start (names, jargon, agenda). Vocabulary hints for ASR and summary. |
| `roster` | String[], default `[]` | Participant names from `POST /roster`. Name hints for w2-spk, not speaker rows. |

## LiveChunk (new)

One chunk uploaded under the capture contract. `@@unique([sessionId,
seq])` is what makes uploads idempotent.

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | → LiveSession (cascade) | |
| `seq` | Int | Chunk number from the recorder. |
| `path` | String | Stored file, kept for re-processing. |
| `startOffsetMs` / `durationMs` | Int | Position on the meeting timeline. |
| `channelLayout` | String, default `mono` | `stereo-mic-left` \| `mono`. |
| `status` | String, default `RECEIVED` | `RECEIVED` \| `PROCESSING` \| `TRANSCRIBED` \| `FAILED`. |
| `error` | String? | Last failure message (FAILED). |
| `segmentCount` | Int, default 0 | Segments produced. |
| `result` | Json? | The response body, replayed for duplicate uploads. |

## Accounts, devices, series (w4-acct)

Migration `20261115120000_w4_accounts`. Additive only: new tables, new
nullable or defaulted columns, new indexes. Existing rows keep working;
the existing dev user gets a password from the CLI
(`npm --prefix backend run user:password`).

### User (new columns)

| Field | Type | Meaning |
| --- | --- | --- |
| `passwordHash` | String? | argon2id hash. Null = cannot sign in until a password is set. |
| `displayName` | String? | The user's own label for mic-channel segments ("You" when null). |
| `timezone` | String? | IANA zone for resolving spoken dates; null = UTC. |
| `defaultMode` | String, default `AUTO` | Mode used when a meeting arrives without one or with `AUTO`. |
| `transcriptionProvider` | String? | `local` \| `deepgram`; null = the server's `TRANSCRIPTION_PROVIDER`. |
| `glossary` | String[], default `[]` | Personal vocabulary, added to transcription and summary hints. |
| `audioRetention` | String, default `KEEP` | `KEEP` \| `AFTER_PROCESSING` \| `AFTER_DAYS`. Enforced by the scheduled retention job. |
| `audioRetentionDays` | Int? | N for `AFTER_DAYS`. |

### Session (new)

express-session store. `sid` (PK), `data` (Json), `expiresAt`, `userId?`
(set once logged in, cascade), `createdAt`, `updatedAt`.

### DeviceToken (new)

Per-user Bearer token for a recorder, replacing the shared
`DEVICE_TOKEN`. Only `tokenHash` (SHA-256, unique) is stored; the token
is shown once. `name`, `kind` (`EXTENSION` \| `DESKTOP` \| `OTHER`),
`prefix` (for display), `lastUsedAt?`, `revokedAt?` (revoked = rejected).

### Series (new) and Meeting.seriesId

`Series { userId, name }`, unique per user. `Meeting.seriesId?` (on
delete: set null) links a meeting to its series; "Since last time"
compares a meeting with the previous one in its series. The result is
stored in `Summary.data.sinceLastTime`, so it needs no column.

### Meeting.audioDeletedAt, ChatMessage.userId

- `Meeting.audioDeletedAt?`: when the retention job removed the
  recording (`audioPath` is then null).
- `ChatMessage.userId?` (cascade): owner of a chat thread. Workspace-wide
  threads have no meeting, so this is what scopes them. Null for rows
  written before accounts; those are not shown to anyone.
