# w1-asr decisions (transcription engine)

## 1. faster-whisper replaces openai-whisper

Same Whisper weights, run through CTranslate2: roughly 4x faster on CPU
with int8, no torch, and it ships Silero VAD and word timestamps, which
the guards and chunk de-duplication need.

- `WHISPER_MODEL` (default `small`), `WHISPER_DEVICE` (`auto` picks CUDA
  when CTranslate2 sees a GPU), `WHISPER_COMPUTE_TYPE` (default int8 on
  CPU, float16 on CUDA), `WHISPER_LANGUAGE` (empty = auto-detect).
- The model still loads lazily on the first transcription; `/health`
  reports `loaded`.
- `condition_on_previous_text=False`: conditioning is the main cause of
  Whisper's repetition loops, and live chunks are short, so little
  context is lost.
- Alternatives: whisper.cpp (needs a native build on every OS), WhisperX
  (pulls torch and pyannote back in; w2-spk owns acoustic diarization).

## 2. Stereo: one pass per channel

`stereo-mic-left` is decoded with `split_stereo=True`; left is
transcribed as `channel: "mic"`, right as `"remote"`, then merged by
start time. A channel quieter than `SILENT_CHANNEL_RMS` (~-60 dBFS) is
skipped (a muted mic only gives Whisper room to hallucinate). Without
headphones the remote audio leaks into the mic, so a mic segment that
overlaps a remote one by >= 50% and matches its text >= 0.8 is dropped
as echo. Cost: two Whisper passes per stereo chunk; VAD skips silence,
so in practice each pass only decodes that side's speech.

## 3. Hints

`initial_prompt = "Glossary: <roster names>, <hints>."`, de-duplicated,
each term capped at 80 chars and the prompt at 600 chars (Whisper's
prompt window is 224 tokens and truncates from the front). Roster first
because names are what Whisper misspells. Deepgram gets the same list as
`keywords` (nova-2) or `keyterm` (nova-3), max 100.

## 4. Hallucination guards (`ai-service/asr/guards.py`, named constants)

| Guard | Rule |
| --- | --- |
| No speech | `no_speech_prob > 0.6` AND `avg_logprob < -1.0` (either alone drops quiet real speech) |
| Loop | `compression_ratio > 2.4` drops the segment |
| Repeats | a 1-8 word phrase repeated 3+ times in a row collapses to one copy |
| Non-speech | text made only of `[Music]`, `(silence)`, `♪`, `*applause*`; stock subtitle phrases ("thanks for watching") when `no_speech_prob >= 0.3` |

The backend keeps its old last-line filter (`noSpeechProb > 0.75`).

## 5. Chunk boundaries (engineer decision D1)

VAD inside each chunk plus word-level de-dup at the edges; no overlap,
so the capture contract is unchanged:

1. Silero VAD (min silence 500 ms, pad 200 ms) splits speech at pauses,
   so Whisper never decodes across one.
2. Words within 300 ms of either chunk edge with probability < 0.4 are
   dropped: a word cut in half decodes with low confidence.
3. When the caller passes the previous chunk's tail words
   (`previous_words`, per channel), the longest run (<= 6 words) at the
   head of this chunk that repeats the end of the previous one is
   removed, if it starts within 1.5 s of the previous last word.

Rejected: audio overlap between chunks (changes the capture contract and
every recorder, and doubles Whisper work on the overlap); cutting at VAD
silences on the recorder (the recorder would need VAD and variable
chunk sizes). idx is untouched: segments are still numbered
`seq * 1000 + i` by the caller.

## 6. Providers

`backend/src/providers/transcription/`: `local` (ai-service) and
`deepgram` (plain fetch to `/v1/listen` with `multichannel`, `diarize`,
`utterances`, `smart_format`, keywords). Chosen by
`TRANSCRIPTION_PROVIDER` (default `local`); `env.ts` refuses to boot on
an unknown value or on `deepgram` without `DEEPGRAM_API_KEY`. Deepgram is
paid per audio minute, so it is tested only with a mocked fetch; no real
call was made in this track (engineer decision D2).

`transcribeAudioDetailed(path, offsetMs, options?)` keeps its two-argument
form, so existing callers and test fakes work unchanged. Segments now
carry `channel` and `words` (`{w, startMs, endMs, p}` as in
SCHEMA_NOTES), which callers can store once the wiring below lands.

## 7. Input

`/transcribe` accepts JSON `{file_path, ...}` (backend, shared
filesystem) or multipart with an `audio` file and the same fields as
form values (a remote ai-service, the benchmark). Blocking inference runs
in a thread pool so `/health` keeps answering.

## 8. Benchmark

`npm run bench:asr -- --fetch-sample --url http://localhost:<port>`
downloads a public-domain clip into `recordings/benchmark/` (gitignored)
and reports RTF (median of warm runs; the cold run includes the model
load), segment count and WER (word-level Levenshtein, normalized).

Results (model `small`, CPU int8, 8 logical cores, Windows, `--language
en`, 3 warm runs; clip: JFK inaugural excerpt, 11 s, public domain):

| Case | Warm median | RTF | Segments | Channels | WER |
| --- | --- | --- | --- | --- | --- |
| mono | 6.7 s | 0.61 | 2 | - | 0.00 |
| stereo, mic silent, speech on right | 6.3 s | 0.58 | 2 | remote | 0.00 |
| stereo, same speech on both (full echo) | 12.9 s | 1.18 | 2 | remote | 0.00 |

Cold run (model download + load) was 41 s. The silent mic channel is
skipped, so it costs nothing; a live mic doubles the work, and the echo
guard removed the duplicated mic copy. One short clip is a smoke test,
not an accuracy claim: w2-eval should run the fixture set.

PyAV 19 removed the `metadata_errors` argument that faster-whisper 1.2.1
passes to `av.open`, so `requirements.txt` pins `av<19`.

## Integrator notes (requests for other tracks)

- `live.service.ts` (~:164 and ~:294): pass
  `{ channelLayout, hints: session.hints, roster: session.roster names,
  previousWords }` as the 3rd argument of `transcribeAudioDetailed`.
- `segment.repository.ts`: write `channel` and `words` in
  `replaceForMeeting`, `appendForMeeting` and `insertAtIdx`.
- `types/segment.ts`: `RawSegment` gains `channel?` and `words?`
  (`AsrSegment` in speech.service.ts has the shape).
- ai-service now needs `faster-whisper` instead of `openai-whisper`
  (`npm run setup:ai` in each checkout that runs it).
