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
