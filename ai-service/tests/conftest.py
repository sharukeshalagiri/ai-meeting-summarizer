"""
A fake `faster_whisper` module, installed before `main` is imported, so
the suite needs neither CTranslate2 nor a model download and fails
loudly if something loads a real model.

How the fake works: a test writes a small JSON "audio" file describing
each channel as {"marker": float, "seconds": n}. `decode_audio` turns it
into constant waveforms filled with the marker, and
`WhisperModel.transcribe` looks up the scripted segments for the
waveform's marker. Marker 0.0 is silence.
"""

import json
import sys
import types
from types import SimpleNamespace

import numpy as np
import pytest

SR = 16_000


def word(text, start, end, p=0.95):
    return SimpleNamespace(word=text, start=start, end=end, probability=p)


def seg(text, start, end, words=None, no_speech=0.05, logprob=-0.2, ratio=1.4):
    """A scripted Whisper segment. words: list of (text, start, end[, p])."""
    if words is None:
        tokens = text.split()
        step = (end - start) / max(1, len(tokens))
        words = [
            (" " + t, start + i * step, start + (i + 1) * step)
            for i, t in enumerate(tokens)
        ]
    return SimpleNamespace(
        text=" " + text,
        start=start,
        end=end,
        no_speech_prob=no_speech,
        avg_logprob=logprob,
        compression_ratio=ratio,
        words=[word(*w) for w in words],
    )


class FakeWhisper:
    def __init__(self):
        self.loads = []
        self.calls = []
        self.scripts = {}
        self.language = "en"

    def module(self):
        fake = types.ModuleType("faster_whisper")
        owner = self

        class WhisperModel:
            def __init__(self, name, device="cpu", compute_type="default"):
                owner.loads.append(
                    {"name": name, "device": device, "compute_type": compute_type}
                )

            def transcribe(self, audio, **kwargs):
                marker = round(float(audio[0]), 3) if len(audio) else 0.0
                owner.calls.append({"marker": marker, **kwargs})
                segments = list(owner.scripts.get(marker, []))
                return iter(segments), SimpleNamespace(language=owner.language)

        def decode_audio(path, sampling_rate=SR, split_stereo=False):
            with open(path, encoding="utf8") as f:
                spec = json.load(f)
            waves = [
                np.full(int(c["seconds"] * sampling_rate), c["marker"], dtype=np.float32)
                for c in spec["channels"]
            ]
            if split_stereo:
                if len(waves) == 1:
                    waves = waves * 2
                return waves[0], waves[1]
            return waves[0]

        fake.WhisperModel = WhisperModel
        fake.decode_audio = decode_audio
        return fake


def write_audio(path, *channels):
    """channels: (marker, seconds) per channel."""
    path.write_text(
        json.dumps(
            {"channels": [{"marker": m, "seconds": s} for m, s in channels]}
        ),
        encoding="utf8",
    )
    return path


@pytest.fixture()
def fake_whisper(monkeypatch):
    fake = FakeWhisper()
    monkeypatch.setitem(sys.modules, "faster_whisper", fake.module())
    # No CTranslate2 in tests: device auto must fall back to CPU.
    monkeypatch.setitem(sys.modules, "ctranslate2", None)
    monkeypatch.setenv("WHISPER_MODEL", "tiny")
    monkeypatch.delenv("WHISPER_DEVICE", raising=False)
    monkeypatch.delenv("WHISPER_LANGUAGE", raising=False)
    monkeypatch.delenv("WHISPER_COMPUTE_TYPE", raising=False)
    # Re-import so env and the fake module apply.
    for name in [n for n in sys.modules if n == "main" or n == "asr" or n.startswith("asr.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    return fake


@pytest.fixture()
def app_module(fake_whisper):
    import main

    main.fake = fake_whisper
    return main
