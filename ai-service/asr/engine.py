"""
faster-whisper model loading and one-pass transcription of a waveform.

Why faster-whisper over openai-whisper: the same Whisper weights run
through CTranslate2, which is roughly 4x faster on CPU with int8
quantisation and needs no torch. It also ships Silero VAD and word
timestamps, which the guards and chunk de-duplication rely on.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field

SAMPLE_RATE = 16_000

MODEL_NAME = os.getenv("WHISPER_MODEL", "small")
# auto | cpu | cuda. auto picks CUDA when CTranslate2 sees a GPU.
DEVICE_SETTING = os.getenv("WHISPER_DEVICE", "auto").strip().lower() or "auto"
# Empty = auto-detect per chunk. An ISO 639-1 code (e.g. "en") skips
# detection, which is faster and avoids misdetection on short chunks.
LANGUAGE_SETTING = os.getenv("WHISPER_LANGUAGE", "").strip().lower() or None
# Optional override; otherwise int8 on CPU, float16 on CUDA.
COMPUTE_TYPE_SETTING = os.getenv("WHISPER_COMPUTE_TYPE", "").strip() or None

BEAM_SIZE = 5
# Silero VAD settings. A silence must last this long before VAD splits
# speech there; shorter pauses stay inside one speech region.
VAD_MIN_SILENCE_MS = 500
# Padding kept around each speech region so word onsets are not clipped.
VAD_SPEECH_PAD_MS = 200
# Skip silent stretches longer than this (seconds) when a hallucination
# is suspected (faster-whisper's own guard; needs word timestamps).
HALLUCINATION_SILENCE_SECONDS = 2.0

_model = None
_model_lock = threading.Lock()
_device: str | None = None


@dataclass
class EngineWord:
    word: str
    start: float
    end: float
    probability: float


@dataclass
class EngineSegment:
    """One Whisper segment in seconds relative to the waveform start."""

    text: str
    start: float
    end: float
    no_speech_prob: float = 0.0
    avg_logprob: float = 0.0
    compression_ratio: float = 1.0
    words: list[EngineWord] = field(default_factory=list)


@dataclass
class EngineResult:
    segments: list[EngineSegment]
    language: str | None


def is_loaded() -> bool:
    return _model is not None


def resolve_device() -> str:
    """cuda when asked for or (auto) when CTranslate2 sees a GPU, else cpu."""
    if DEVICE_SETTING in ("cpu", "cuda"):
        return DEVICE_SETTING

    try:
        import ctranslate2  # bundled with faster-whisper

        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:  # noqa: BLE001 - no CTranslate2/CUDA means CPU
        return "cpu"


def resolve_compute_type(device: str) -> str:
    # int8 keeps CPU inference fast with negligible accuracy loss;
    # float16 is the native fast path on GPUs.
    if COMPUTE_TYPE_SETTING:
        return COMPUTE_TYPE_SETTING
    return "float16" if device == "cuda" else "int8"


def get_model():
    """Loads the model once, on first use, and reuses it for every request."""
    global _model, _device

    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel

                device = resolve_device()
                _model = WhisperModel(
                    MODEL_NAME,
                    device=device,
                    compute_type=resolve_compute_type(device),
                )
                _device = device

    return _model


def decode(path: str, split_stereo: bool):
    """
    Decodes any ffmpeg-readable file to 16 kHz float32 (PyAV, bundled
    with faster-whisper). With split_stereo it returns (left, right).
    """
    from faster_whisper import decode_audio

    return decode_audio(path, sampling_rate=SAMPLE_RATE, split_stereo=split_stereo)


def transcribe_waveform(
    audio,
    language: str | None = None,
    initial_prompt: str | None = None,
) -> EngineResult:
    """Runs one waveform through Whisper with VAD and word timestamps."""
    model = get_model()

    segments, info = model.transcribe(
        audio,
        language=language or LANGUAGE_SETTING,
        initial_prompt=initial_prompt or None,
        beam_size=BEAM_SIZE,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": VAD_MIN_SILENCE_MS,
            "speech_pad_ms": VAD_SPEECH_PAD_MS,
        },
        word_timestamps=True,
        # Conditioning on the previous window is the main cause of
        # Whisper's repetition loops; chunks are short, so little context
        # is lost by turning it off.
        condition_on_previous_text=False,
        hallucination_silence_threshold=HALLUCINATION_SILENCE_SECONDS,
    )

    out: list[EngineSegment] = []

    # `segments` is a lazy generator: decoding happens while iterating.
    for raw in segments:
        out.append(
            EngineSegment(
                text=(raw.text or "").strip(),
                start=float(raw.start),
                end=float(raw.end),
                no_speech_prob=float(getattr(raw, "no_speech_prob", 0.0) or 0.0),
                avg_logprob=float(getattr(raw, "avg_logprob", 0.0) or 0.0),
                compression_ratio=float(
                    getattr(raw, "compression_ratio", 1.0) or 1.0
                ),
                words=[
                    EngineWord(
                        word=w.word,
                        start=float(w.start),
                        end=float(w.end),
                        probability=float(w.probability),
                    )
                    for w in (getattr(raw, "words", None) or [])
                ],
            )
        )

    return EngineResult(segments=out, language=getattr(info, "language", None))
