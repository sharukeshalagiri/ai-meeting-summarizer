# w1-desk decisions (desktop recorder)

Track scope: `desktop-recorder/**`. **The backend is unchanged.** The chunk
route accepts any `audio/*` file, `source: "DESKTOP"` already exists, and
Slack and Discord are sent as `platform: "OTHER"`.

## 1. Chunk format: PENDING ENGINEER DECISION (options 1/2/3)

The contract allows 10–30 s chunks in "anything ffmpeg decodes". The brief
requires chunk length and encoding identical to the extension (w1-ext).
The web page and the extension use `CHUNK_MS = 20000` and
`audio/webm;codecs=opus` today.

| Option | Format | Trade-off |
| --- | --- | --- |
| **1 (implemented, provisional)** | 20 s chunks of 48 kHz stereo Opus in **Ogg** (libsndfile through `soundfile`) | Same length and codec as the extension, but a different container (Ogg vs WebM), which Whisper and ffmpeg ignore. About 160 KB per chunk. No ffmpeg on the user's machine. |
| 2 | 20 s of 48 kHz WebM/Opus through PyAV | Byte-for-byte the same container as MediaRecorder, but adds the FFmpeg libraries to the bundle (+30–60 MB) and a riskier PyInstaller build. |
| 3 | 20 s of 16 kHz 16-bit stereo WAV | Simplest, with no codec. About 1.3 MB per chunk and not the extension's format. |

It is built as single constants in `src/desk_recorder/config.py`
(`CHUNK_MS`, `SAMPLE_RATE`, `ENCODING`), with swappable encoders in
`encoder.py`, so switching is a one-line change. w1-ext should keep 20 s
stereo Opus so that option 1 stays "identical except the container".

## 2. Stack

- **Python 3.11+** has the best ecosystem for desktop audio capture. One
  codebase covers Windows, Linux and macOS.
- **PyAudioWPatch** (Windows): the only maintained pip package with
  WASAPI loopback, so it needs no Stereo Mix or virtual cable. The
  alternatives were `soundcard` (loopback works but is less maintained and
  has COM-threading pitfalls) and raw comtypes WASAPI (too much code).
- **`parec` subprocess** (Linux): works on PulseAudio and PipeWire
  (pipewire-pulse) with no Python native dependency.
- **sounddevice + BlackHole** (macOS): there is no OS loopback API without
  a virtual device or ScreenCaptureKit (which would need PyObjC and new
  permissions).
- **pystray + Pillow** for the tray (one API on all three OSes), and
  **tkinter** for dialogs and settings (stdlib, about 5 MB in the bundle).
  Qt was rejected as about 60 MB more for a few dialogs. Electron would
  have meant a second Node app and its own audio stack.
- **soundfile** (bundled libsndfile 1.2) writes Ogg/Opus without ffmpeg.
  **numpy** does the mixing. **requests** handles HTTP. **psutil** lists
  processes.
- **PyInstaller `--onedir --windowed`**: about 75 MB, it starts fast and
  avoids the antivirus false positives that `--onefile` self-extraction
  attracts. The build command is in the README. No build is committed.

## 3. Stereo alignment (StereoMixer)

- Each device stream is downmixed to mono and resampled to 48 kHz with
  streaming linear interpolation. scipy would add about 40 MB for no gain
  on speech that Whisper resamples to 16 kHz anyway.
- **The microphone drives the clock.** WASAPI loopback delivers nothing
  while nothing is playing, so the system side is padded with silence.
  Short system blocks are right-aligned, so audio that resumes after
  silence isn't shifted early. The system backlog is capped at 0.5 s to
  absorb drift between the two device clocks.
- Offsets come from the sample count (`seq * CHUNK_MS`), never from wall
  time or upload time.
- If the mic stops delivering frames for 10 s (for example the device was
  unplugged), recording stops with a notification and every chunk recorded
  so far is kept.

## 4. Queue and retry

- One folder per recording. Audio is written to a `.part` file and moved
  into place, then the JSON metadata is written. A chunk exists only once
  its JSON does, and files are deleted only after a 200.
- If the backend is down when recording starts, recording still starts.
  The session is created on the backend later, before the first upload.
- Status handling: 200 or `duplicate:true` = done. 409 = retry the same
  chunk (other seqs continue). 5xx, 429 or network errors = back off this
  session. 401 = pause all uploads until Settings change. 410 = move the
  session's audio to `failed/`. 400, 404 and other 4xx = move that chunk
  to `failed/` with a `reason.txt`. Audio is never silently deleted.
- `/end` is sent only after every chunk is confirmed. Since #7, `/end`
  returns immediately (`summary: null, summarizing: true`) and the
  summary runs in the background, so any 2xx finishes the local session
  and `/end` uses the short 30 s timeout.
- Chunk upload timeout is 300 s, because the backend transcribes before
  it answers. A timeout is safe: the retry gets 409 and then
  `duplicate:true`.

## 5. Meeting detection

On Windows, the HKCU `CapabilityAccessManager\ConsentStore\microphone`
registry store shows which app is using the mic now
(`LastUsedTimeStop == 0`), with no admin rights. A prompt needs a known
call process **and** that app holding the mic, because Zoom, Slack and
Teams idle in the background all day. Linux uses `pactl list
source-outputs`. macOS falls back to process presence only. Detection is
edge-triggered (one prompt per call) and **never starts recording by
itself**.

## 6. Security notes

The device token is stored in plain text in the user's `settings.json`
(the same trust level as the extension's `chrome.storage.local`), and is
masked in the Settings UI. It could move to the OS keyring later
(`keyring`).

## For the integrator

- **Add a CI job** (`.github/workflows/ci.yml` is not this track's file):
  `actions/setup-python` 3.11+ and `node desktop-recorder/run-tests.mjs`
  on ubuntu-latest. It needs no sound card. I added `npm run
  test:desktop` (append-only) but did **not** add it to `npm test`, which
  would mean editing an existing line.
- Tested on Windows 11: the tests, device enumeration, loopback discovery,
  tray menu construction and the built exe starting. The test machine has
  **no microphone**, so a real recording needs the manual test in the
  README (gate f).
