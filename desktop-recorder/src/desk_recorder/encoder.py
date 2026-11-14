"""Chunk encoders, swappable behind config.ENCODING.

PROVISIONAL default "ogg-opus": the same codec (Opus, 48 kHz stereo) and
chunk length as the extension's MediaRecorder output; only the container
differs (Ogg vs WebM), which ffmpeg/Whisper don't care about. libsndfile
(bundled in the soundfile wheels) writes it, so the user needs no ffmpeg.
"wav" is the zero-codec fallback (16-bit PCM, ~3.8 MB per 20 s at 48 kHz).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from desk_recorder.config import ENCODING


@dataclass(frozen=True)
class Encoder:
    key: str
    extension: str
    mime_type: str
    sf_format: str
    sf_subtype: str

    def encode(self, frames: np.ndarray, rate: int, path: Path) -> None:
        """Write a float32 (n, 2) array to `path`."""
        clipped = np.clip(np.asarray(frames, dtype=np.float32), -1.0, 1.0)
        sf.write(str(path), clipped, rate, format=self.sf_format, subtype=self.sf_subtype)


ENCODERS = {
    "ogg-opus": Encoder("ogg-opus", ".ogg", "audio/ogg", "OGG", "OPUS"),
    "wav": Encoder("wav", ".wav", "audio/wav", "WAV", "PCM_16"),
}


def get_encoder(key: str = ENCODING) -> Encoder:
    try:
        return ENCODERS[key]
    except KeyError:
        raise ValueError(f"Unknown encoding {key!r}; expected one of {sorted(ENCODERS)}") from None
