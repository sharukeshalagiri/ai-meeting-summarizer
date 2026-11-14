# Desktop recorder

A tray app that records **any desktop call app** (the Zoom desktop app,
Teams, Slack, Discord, anything that plays sound) and streams it to the
backend over the [capture contract](../docs/CAPTURE_CONTRACT.md), in the
same stereo format as the Chrome extension:

- **Left channel = your microphone. Right channel = everyone else** (system audio).
- `source: "DESKTOP"`, `channelLayout: "stereo-mic-left"`.

| Platform | Capture | Status |
| --- | --- | --- |
| Windows 10/11 | mic + WASAPI loopback (PyAudioWPatch) | built and tested |
| Linux | mic + PulseAudio/PipeWire monitor (`parec`) | **untested** |
| macOS | mic + BlackHole virtual device | **untested** |

## What it does

- **Tray menu:** status (Idle / Recording hh:mm:ss), "N chunks waiting",
  Start/Stop recording, Mode (Auto, General, Lecture, Interview, Project,
  1:1), Hints..., Open meeting in web app, Settings..., Quit. The icon is
  a **red dot while recording**, with an amber badge while chunks wait to upload.
- **Meeting detection:** when Zoom/Teams/Slack/Discord is running *and*
  using the microphone, it asks "Meeting detected, start recording?". It
  **never records without your click**.
- **Durable upload queue:** each 20 s chunk is written to a local queue
  folder first, then uploaded with retry and backoff (2, 4, 8 ... 30 s).
  A chunk is deleted only after the backend confirms it. The queue survives
  restarts, crashes and network drops, and it resumes on the next start.
  `409` (still processing) is retried, and `duplicate: true` counts as
  done. A `401` pauses uploads until you fix the token. On `410` (session
  ended) or `400` the audio is kept in `failed/` with a `reason.txt`. It is
  never silently dropped.

Data lives in `%APPDATA%\MeetingRecorder` (Windows),
`~/Library/Application Support/MeetingRecorder` (macOS) or
`~/.config/MeetingRecorder` (Linux): `settings.json`, `queue/`,
`failed/`, `recorder.log`. Set `DESK_RECORDER_HOME` to use another folder.

## Audio format (provisional)

One place: `src/desk_recorder/config.py`. The values are `CHUNK_MS = 20000`,
`SAMPLE_RATE = 48000`, `ENCODING = "ogg-opus"` (48 kHz stereo Opus in
Ogg, about 160 KB per chunk, written by libsndfile, so no ffmpeg is needed).
`"wav"` is the fallback encoder. **The chunk format is pending the
engineer's decision** (see `docs/decisions/w1-desk.md`), and it must stay
identical to the extension's.

## Run from source (Windows)

Requires Python 3.11+.

```powershell
cd desktop-recorder
py -3 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
$env:PYTHONPATH = "src"
.venv\Scripts\python -m desk_recorder              # real devices
.venv\Scripts\python -m desk_recorder --fake-audio # synthetic tones, no capture
```

Open **Settings...** and set the backend API URL (e.g.
`http://localhost:5000/api`), the web app URL (`http://localhost:5173`),
the device token (the backend's `DEVICE_TOKEN`; leave it empty in
development if the backend has none), and optionally the mic and output
device.

## Build the Windows app (PyInstaller)

```powershell
cd desktop-recorder
.venv\Scripts\python -m pip install -r requirements-build.txt
.venv\Scripts\python -m PyInstaller --noconfirm --clean --windowed --name MeetingRecorder --paths src src\desk_recorder\__main__.py
```

The output is `dist\MeetingRecorder\MeetingRecorder.exe` (a one-folder
build of about 75 MB; `dist/`, `build/` and the generated `.spec` are
gitignored). Never commit the build.

## Tests

```bash
npm run test:desktop                 # from the repo root
node desktop-recorder/run-tests.mjs  # same thing
```

This creates `desktop-recorder/.venv` if it is missing, installs
`requirements-dev.txt` (numpy, soundfile, requests, psutil, pytest: no
device or tray packages) and runs pytest. No sound card is needed. The
tests generate tones in code, and no audio files are committed.

- **Channels:** a 440 Hz tone on the "mic" lands only in the left channel
  and a 1 kHz tone on the "system" only in the right (FFT, more than 30 dB
  of separation), including after Opus/WAV encoding. Inputs run at
  44.1 kHz mono and 48 kHz stereo to exercise resampling and downmixing.
- **Queue and retry:** 200, `duplicate: true`, 409, 502, 503, 429,
  network errors, 401 pause and resume, 410, 400, a backend that is down
  at start, `/end` only after the last chunk, and resume after a restart
  (including a half-written chunk).
- **Detection rules,** the controller, and settings.

## Manual test (Windows, about 2 minutes, needs a real call)

1. Start the backend (`npm run dev:api`) and the web app.
2. Run the recorder from source (above) and set the URLs and token in Settings.
3. Join a Zoom desktop test call (`zoom.us/test`) or play a YouTube video,
   and say a sentence into your mic.
4. If Zoom is in a call, a "Meeting detected" prompt appears; click
   **Yes**. Otherwise use tray, then **Start recording**. The icon turns red.
5. Wait about 45 s, then tray, then **Stop recording**. "N chunks waiting" drops to 0.
6. Tray, then **Open meeting in web app**: the transcript has your
   sentence and the call audio.
7. Offline check: stop the backend, record 30 s, stop. The tray shows
   "N chunks waiting". Restart the backend and the count drains to 0.

## Linux (untested)

Install `pulseaudio-utils` (`parec`, `pactl`; works with PipeWire through
pipewire-pulse) and a tray host (AppIndicator on GNOME). The mic is
`@DEFAULT_SOURCE@`, and system audio is the output sink's `.monitor`.
`pip install -r requirements.txt`, then run it as above.

## macOS (untested)

macOS can't capture system audio without a virtual device:

1. `brew install blackhole-2ch` (or install it from existential.audio).
2. In **Audio MIDI Setup**, create a **Multi-Output Device** with your
   speakers and BlackHole 2ch, and select it as the system output (so you
   still hear the call).
3. Grant the app microphone permission when macOS asks.

On start the recorder checks that BlackHole exists and otherwise shows
these steps. Meeting detection on macOS only checks for the process (there
is no public mic-usage API).
