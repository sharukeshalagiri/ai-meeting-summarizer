"""
Diarization engines, chosen by DIARIZATION_ENGINE.

- `sherpa` (default): sherpa-onnx speaker-embedding extractor, CPU, no
  torch. Embeds each segment; clustering is ours (cluster.py).
- `pyannote` (optional, not installed by default): runs
  pyannote/speaker-diarization-3.1 on the remote channel and returns its
  speaker turns plus one embedding per speaker. Needs torch,
  `pip install pyannote.audio`, HF_TOKEN and accepting the model's
  conditions on Hugging Face (engineer's gate e). Well over the 1 GB RAM
  budget on this laptop, so it is opt-in.

Every engine loads lazily and once, so /health never loads a model and
tests can swap in a fake via set_engine().
"""

from __future__ import annotations

import os
import threading
from typing import Protocol

import numpy as np

from . import models

SAMPLE_RATE = 16_000


class EngineUnavailable(RuntimeError):
    """The engine's package or model cannot be loaded (HTTP 503)."""


class Engine(Protocol):
    name: str
    model: str

    def embed(self, samples: np.ndarray) -> np.ndarray: ...


class SherpaEngine:
    name = "sherpa"

    def __init__(self) -> None:
        self.model = models.model_name()
        self._extractor = None
        self._lock = threading.Lock()

    def _load(self):
        with self._lock:
            if self._extractor is not None:
                return self._extractor
            try:
                import sherpa_onnx
            except ImportError as exc:
                raise EngineUnavailable(
                    "sherpa-onnx is not installed (pip install -r diarization/requirements.txt)"
                ) from exc
            try:
                path = models.resolve_model(self.model)
            except Exception as exc:  # noqa: BLE001 - download/IO, reported as 503
                raise EngineUnavailable(f"speaker model unavailable: {exc}") from exc

            threads = int(os.getenv("SPEAKER_EMBEDDING_THREADS", "1") or 1)
            config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(path), num_threads=max(1, threads), provider="cpu"
            )
            if not config.validate():
                raise EngineUnavailable(f"invalid speaker model config for {path}")
            self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
            return self._extractor

    def is_loaded(self) -> bool:
        return self._extractor is not None

    def embed(self, samples: np.ndarray) -> np.ndarray:
        extractor = self._load()
        stream = extractor.create_stream()
        stream.accept_waveform(
            sample_rate=SAMPLE_RATE, waveform=np.ascontiguousarray(samples, dtype=np.float32)
        )
        stream.input_finished()
        return np.asarray(extractor.compute(stream), dtype=np.float64)


class PyannoteEngine:
    """Full pyannote 3.1 pipeline. Optional; see the module docstring."""

    name = "pyannote"
    model = "pyannote/speaker-diarization-3.1"

    def __init__(self) -> None:
        self._pipeline = None
        self._lock = threading.Lock()

    def _load(self):
        with self._lock:
            if self._pipeline is not None:
                return self._pipeline
            try:
                from pyannote.audio import Pipeline
            except ImportError as exc:
                raise EngineUnavailable("pyannote.audio is not installed") from exc
            token = os.getenv("HF_TOKEN", "").strip()
            if not token:
                raise EngineUnavailable("HF_TOKEN is required for pyannote")
            self._pipeline = Pipeline.from_pretrained(self.model, use_auth_token=token)
            return self._pipeline

    def is_loaded(self) -> bool:
        return self._pipeline is not None

    def embed(self, samples: np.ndarray) -> np.ndarray:  # pragma: no cover - protocol only
        raise NotImplementedError("pyannote diarizes whole waveforms; see diarize_waveform")

    def diarize_waveform(self, samples: np.ndarray):
        """[(start_s, end_s, label)], {label: embedding}."""
        import torch  # present whenever pyannote is

        pipeline = self._load()
        waveform = torch.from_numpy(np.asarray(samples, dtype=np.float32)).unsqueeze(0)
        annotation, embeddings = pipeline(
            {"waveform": waveform, "sample_rate": SAMPLE_RATE}, return_embeddings=True
        )
        labels = annotation.labels()
        turns = [
            (turn.start, turn.end, label)
            for turn, _, label in annotation.itertracks(yield_label=True)
        ]
        return turns, {label: np.asarray(embeddings[i]) for i, label in enumerate(labels)}


_engine = None
_engine_lock = threading.Lock()


def engine_name() -> str:
    return (os.getenv("DIARIZATION_ENGINE", "") or "sherpa").strip().lower()


def get_engine():
    global _engine
    with _engine_lock:
        if _engine is None:
            name = engine_name()
            if name == "sherpa":
                _engine = SherpaEngine()
            elif name == "pyannote":
                _engine = PyannoteEngine()
            else:
                raise EngineUnavailable(f"unknown DIARIZATION_ENGINE {name!r}")
        return _engine


def set_engine(engine) -> None:
    """Replaces the engine (tests)."""
    global _engine
    with _engine_lock:
        _engine = engine
