"""Recorder constants and user settings.

The audio format lives here as single constants so it can change in one
place. It must stay identical to the Chrome extension's (w1-ext): both
recorders feed the same backend and the same channel-aware ASR.

PROVISIONAL: the chunk format is pending the engineer's decision
(docs/decisions/w1-desk.md, options 1/2/3). Option 1 is implemented:
20 s chunks, 48 kHz stereo Opus in an Ogg container.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

# --- Audio format (capture contract) ------------------------------------

#: Milliseconds of audio per chunk. Matches CHUNK_MS in the extension and
#: the web page (20 s): enough context for Whisper to punctuate, few
#: enough round trips to keep the live transcript current.
CHUNK_MS = 20_000

#: Sample rate every chunk is encoded at. Opus only runs at 48 kHz (and a
#: few lower rates); 48 kHz is also what MediaRecorder produces.
SAMPLE_RATE = 48_000

#: Encoder key, see encoder.get_encoder(). "ogg-opus" (provisional
#: default) or "wav" (16-bit PCM fallback).
ENCODING = "ogg-opus"

#: Left = my microphone, right = everyone else (system audio).
CHANNEL_LAYOUT = "stereo-mic-left"

#: Final partial chunks shorter than this are dropped on stop: a click
#: on "Stop" a fraction of a second into a chunk carries no speech.
MIN_FINAL_CHUNK_MS = 1_000

#: Contract values for POST /sessions.
MODES = ("AUTO", "GENERAL", "LECTURE", "INTERVIEW", "PROJECT", "ONE_ON_ONE")
SOURCE = "DESKTOP"

# --- Upload retry (capture contract: 2 s, 4 s, 8 s ... capped at 30 s) ---

BACKOFF_BASE_S = 2.0
BACKOFF_CAP_S = 30.0


def backoff_seconds(attempts: int) -> float:
    """Delay before the next try after `attempts` failed tries (1-based)."""
    if attempts <= 0:
        return 0.0
    return min(BACKOFF_BASE_S * (2 ** (attempts - 1)), BACKOFF_CAP_S)


# --- Paths ---------------------------------------------------------------

APP_NAME = "MeetingRecorder"


def app_dir() -> Path:
    """Per-user data folder (settings + upload queue).

    `DESK_RECORDER_HOME` overrides it, which tests and portable installs use.
    """
    override = os.environ.get("DESK_RECORDER_HOME")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / APP_NAME


def queue_dir() -> Path:
    return app_dir() / "queue"


# --- Settings ------------------------------------------------------------


@dataclass
class Settings:
    """User settings, stored as JSON in app_dir()/settings.json.

    The device token is stored in plain text in the user's profile folder,
    the same trust level as the extension's chrome.storage.local.
    """

    #: API base, same shape as VITE_API_URL / the extension's apiBase.
    api_url: str = "http://localhost:5000/api"
    #: Web app origin, used for "Open meeting in web app".
    web_url: str = "http://localhost:5173"
    device_token: str = ""
    #: Device names; empty = system default.
    mic_device: str = ""
    output_device: str = ""
    mode: str = "AUTO"
    hints: list[str] = field(default_factory=list)
    #: Watch for meeting apps and offer to record (never records by itself).
    detect_meetings: bool = True

    @classmethod
    def load(cls, path: Path | None = None) -> "Settings":
        path = path or app_dir() / "settings.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        if not isinstance(raw, dict):
            return cls()
        known = {f.name for f in fields(cls)}
        settings = cls(**{k: v for k, v in raw.items() if k in known})
        if settings.mode not in MODES:
            settings.mode = "AUTO"
        if not isinstance(settings.hints, list):
            settings.hints = []
        settings.hints = [str(h) for h in settings.hints][:20]
        return settings

    def save(self, path: Path | None = None) -> None:
        path = path or app_dir() / "settings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        os.replace(tmp, path)
