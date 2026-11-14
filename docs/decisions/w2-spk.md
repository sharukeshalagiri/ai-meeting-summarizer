# w2-spk decisions (who said what)

For the integrator to fold into `docs/DECISIONS.md` / `CLAUDE.md`.

## D1. Me = the mic channel, no model

Every segment on the `"mic"` channel (left channel of the capture
contract) is the user: one SpeakerProfile with label `mic`, shown as its
display name or `ME_DISPLAY_NAME` (default "You"). Echo of remote speech
on the mic is already dropped by w1-asr (`drop_echo`), so it is not
handled again here. This also applies to uploads (`diarizeSegments`
without context), so a stereo upload's mic lines are "You".

## D2. Others: voice diarization, sherpa-onnx by default

Options compared (engineer's brief). Numbers are from documentation
except the "measured" column, which is this track's 10-minute bench.

| Option | Extra RAM | Speed (CPU) | Accuracy | Licence / cost |
| --- | --- | --- | --- | --- |
| **(a) sherpa-onnx + WeSpeaker ResNet34-LM (default)** | **measured +52 MB** after load, +76 MB peak (bench process); ai-service total 149 MB with the model loaded | **measured RTF 0.047** (1 thread) | voice-verification model (no published meeting-diarization number); bench below | Apache-2.0 runtime; CC BY 4.0 weights; free |
| (b) pyannote/speaker-diarization-3.1 | torch + models, well over the 1 GB budget on this laptop (not measured) | model card: RTF ~2.5% on a V100 GPU; CPU much slower | model card DER: AMI 18.8%, VoxConverse 11.3%, DIHARD3 21.7% | MIT code; gated HF model (HF_TOKEN, licence acceptance: gate e) |
| (c) Deepgram `diarize=true` | 0 | network-bound | vendor claims only | paid per audio minute (gate e) |

The WeSpeaker model's published 0.72% is a voice-verification EER, not a
meeting-diarization error; it is deliberately not compared with
pyannote's DER anywhere. The project's real speaker metric is the AMI
DER re-run the lead does after merge (w2-eval).

All three sit behind `DiarizationProvider` (`types/providers.ts`):
`DIARIZATION_PROVIDER=voice` (default) | `text` (Gemini) | `deepgram`.
Voice falls back to text when the ai-service is down or has no model
(503), then to continuity, then to a single speaker: attribution never
fails a chunk. pyannote is an optional ai-service engine
(`DIARIZATION_ENGINE=pyannote`, lazily imported, not installed);
Deepgram's speaker numbers restart every request and it returns no
embeddings, so across chunks it is only label-stable. Neither paid nor
gated path was exercised (no account, no key).

### Model (downloaded on first use, never committed)

| | |
| --- | --- |
| Name | `wespeaker_en_voxceleb_resnet34_LM` (256-d, VoxCeleb, large-margin fine-tuned) |
| File / size | `wespeaker_en_voxceleb_resnet34_LM.onnx`, 26,530,550 bytes |
| URL | `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx` (tag spelling is upstream's) |
| SHA-256 | `e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012` (from the release's `checksum.txt`; verified before use) |
| Account | none: public GitHub release asset, HTTP 200 without auth |
| Licence | CC BY 4.0. WeSpeaker `docs/pretrained.md`: "the pretrained model on VoxCeleb follows Creative Commons Attribution 4.0 International License". Any use, with attribution. |
| Attribution | Speaker embeddings by WeSpeaker (wenet-e2e/wespeaker), trained on VoxCeleb, CC BY 4.0; ONNX export by k2-fsa/sherpa-onnx. |
| Runtime | `sherpa-onnx` 2.0.1 (Apache-2.0, pip, ~2 MB wheel + bundled onnxruntime; no torch) |
| Cache | `ai-service/diarization/.models/` (gitignored by `ai-service/diarization/.gitignore`) or `SPEAKER_MODEL_DIR` |

CI never downloads it: tests use a fake engine and a fake `sherpa_onnx`
module, like the fake whisper.

## D3. Stable labels across chunks (the boundary fix)

Root cause: each live chunk was labelled by Gemini in isolation, so one
person could be "Speaker 2" in chunk n and "Priya" in chunk n+1. Now:

1. The ai-service embeds each remote segment (3 s windows, 1.5 s hop,
   averaged; < 0.5 s skipped) and clusters within the chunk
   (average-linkage cosine, merge at >= 0.5).
2. The backend matches each cluster to the meeting's SpeakerProfile
   centroids (`services/speakers/matcher.ts`), greedy one-to-one, best
   pair first:
   - long clusters (>= 1 s): match at cosine >= 0.55; the centroid moves
     only if the match beats the second-best profile by 0.05;
   - short clusters: match at >= 0.40, else continue the previous
     chunk's last remote speaker if within 1.5 s of the chunk start;
   - no match: new "Speaker N" (cold start: every cluster is new).
3. Centroid update: EMA `c' = normalize((1-a)c + a x)`,
   `a = clamp(ms / (ms + 20 s), 0.05, 0.5)`. No count column needed, so
   **no schema change**.
4. Matching is serialised per meeting (in-memory lock), so concurrent
   chunks never create duplicate profiles.
5. `speakerId` is stored by idx after `insertAtIdx`
   (`speakerProfile.repository.assignSegments`), because
   `segment.repository` (not ours) does not write it.

The text fallback gets the previous chunk's labelled lines and the
meeting's known labels, and maps its labels onto existing profiles by
name. Test: `backend/test/w2-spk/chunkBoundary.test.ts` reproduces the
split with per-chunk text labels and shows it gone with voice matching.

### Bench (10 minutes of one AMI meeting; NOT the official AMI DER)

`python -m diarization.bench --fetch --minutes 10`: AMI ES2004a
Mix-Headset (CC BY 4.0), reference turns from pyannote's
AMI-diarization-setup used as oracle segments (so ASR errors are
excluded), 30 s chunks, one model, CPU, one thread, Windows laptop.

| Metric | Value |
| --- | --- |
| RSS before / after model load | 100 MB / 153 MB (peak 176 MB after embedding 10 min) |
| Model load | 4.6 s |
| Embedding time | 28.4 s for 600 s of audio: RTF 0.047 (0.067 per second of speech) |
| Segment-time speaker error (best 1:1 mapping, oracle segments, no overlap/miss terms) | **22.4%** at the defaults (merge 0.5, match 0.55) |
| Speakers predicted / reference | 11 / 4 (over-segmentation: short turns become extra speakers) |
| Boundary splits (same reference speaker on both sides of a cut, different label) | 5 of 15 |

Threshold sweep (merge x match, 16 settings): with merge 0.3-0.5,
match 0.55 was best (22.4-22.9%); lower match values merged different
people (31-43%) and 0.65 split more (25-28%). With merge 0.6 the chunk
clusters fragment (17-24 predicted speakers, 24-32%). Defaults kept. A one-meeting,
10-minute run is a sanity check, not a claim; the over-segmentation and
remaining boundary splits are the first things to improve (a minimum
cluster duration before creating a profile; merging profiles whose
centroids converge).

Smoke test of the running service (port 5152): `POST /diarize` on a
real 30 s stereo Opus chunk (silent mic, AMI on the right) returned
one 256-d cluster plus one skipped short segment in 1.4 s cold (model
load included) and 1.1 s warm; ai-service RSS 149 MB with the
embedding model loaded and no Whisper model. Two overlapping speakers
in that chunk were merged into one cluster: overlap is not handled.

## D4. Names: two signals to apply, one to suggest

Signals (`services/speakers/names.ts`, pure regexes on ASR text, no
Gemini): `self_intro` ("I'm Priya", "my name is", "this is Priya",
"Priya here"), `roster` (in `LiveSession.roster`), `addressed` (another
speaker says "thanks, Priya", "Priya, can you ...", "..., Priya?").

- **Applied automatically only with two signals:** self_intro AND
  (roster OR addressed by another speaker). Never over a MANUAL rename
  or an existing name, never for the mic.
- One signal is a **suggestion** (`GET /meetings/:id/speakers`), shown
  as a "Priya?" chip the user can accept
  (`POST /meetings/:id/speakers/:key/accept`).
- Works with no roster (desktop recorder): intro + being addressed.
- False positives tested: "I'm Frank about this", "I'm Sam's manager",
  "I'm sorry", "I'm Sure", possessives and adjectives after "I'm".
- A name claimed by two speakers, or the user's own name, is dropped.

## D5. Rename, Correction, and read-time names

`PATCH /meetings/:id/speakers/:key {displayName}` sets the profile's
display name (source MANUAL), renames that speaker's segments, and
records a `SPEAKER` Correction through `correction.repository.record()`
(`before/after: {speaker, label, idx[]}`, `after.via` manual |
suggestion). `key` is the profile id, or `label:<speaker>` for older
segments without a profile (which then get one).

Summaries and tasks are **not rewritten** (w1-sum owns them). Instead
`applySpeakerNames` (pure) projects current names at read time:
evidence `{idx, speaker}` takes the segment's current speaker by idx;
other `speaker` / `owner` / `assignedBy` strings are replaced when they
equal an old name (case-insensitive, whole string). Free text (TL;DR)
is left alone. `withSpeakerNames(meeting)` and `withOwnerNames(items)`
are the one-line hooks for the wiring PR (see the PR's requests).

## D6. Transcript UI

`TranscriptView`: turns merge per speaker key (profile id, else label);
the speaker chip is a rename button with an inline form and an optional
suggestion chip; "Hide noise" (on by default, shown only when something
is labelled) folds `noiseLabel` values other than `substantive` (null =
unclassified, shown). Hidden segments stay in the DOM as
`<span id="seg-<idx>" data-start-ms hidden>`, and a MutationObserver
unfolds one when `jumpToSegment` highlights it, so the UI contract holds.
Renames show at once; summary/task chips update after a refresh (the
segments come from `MeetingDetails`, which is w3-jobs').

## Integrator notes (requests for other tracks)

1. `backend/src/controllers/meeting.controller.ts` `getMeetingById`:
   `return sendSuccess(res, await withSpeakerNames(meeting), "Meeting fetched");`
2. `backend/src/controllers/actionItem.controller.ts` (list):
   wrap the items in `await withOwnerNames(items)`.
   Both from `services/speakers/speakers.service`.
3. `ai-service/pytest.ini`: `testpaths = tests diarization/tests`, so CI
   runs the 25 diarization tests (they pass locally; not collected
   until then).
4. `backend/src/repositories/segment.repository.ts` `segmentColumns`:
   could write `speakerId` directly (with `DiarizedSegment.speakerId?`
   in `types/segment.ts`), which would make the post-insert
   `assignSegments` call unnecessary. Optional.
5. w3-jobs, `meeting.service.ts:172` (uploads): pass
   `{ meetingId, filePath: meeting.audioPath, channelLayout, offsetMs: 0 }`
   as the 2nd argument of `diarizeSegments` to get voice diarization and
   profiles for uploads too. Without it uploads keep text diarization
   (plus the mic rule).
6. CLAUDE.md env table: `DIARIZATION_PROVIDER` (voice), `ME_DISPLAY_NAME`
   (You) in backend; `DIARIZATION_ENGINE`, `SPEAKER_EMBEDDING_MODEL`,
   `SPEAKER_MODEL_DIR`, `SPEAKER_EMBEDDING_THREADS`, `HF_TOKEN` in
   ai-service. `npm run setup:ai` now also installs sherpa-onnx.
