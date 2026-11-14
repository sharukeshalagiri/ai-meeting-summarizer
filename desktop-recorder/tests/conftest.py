"""Shared helpers. Every tone is generated in code; no audio files exist."""

from __future__ import annotations

import numpy as np
import pytest


def band_energy(signal: np.ndarray, rate: int, hz: float, width: float = 30.0) -> float:
    """Energy of `signal` within +-width Hz of `hz` (Hann-windowed FFT)."""
    windowed = signal * np.hanning(len(signal))
    spectrum = np.abs(np.fft.rfft(windowed)) ** 2
    freqs = np.fft.rfftfreq(len(signal), 1 / rate)
    mask = (freqs > hz - width) & (freqs < hz + width)
    return float(spectrum[mask].sum())


def dominant_hz(signal: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(signal * np.hanning(len(signal))))
    return float(np.fft.rfftfreq(len(signal), 1 / rate)[int(np.argmax(spectrum))])


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Isolated app folder so tests never touch the real user profile."""
    monkeypatch.setenv("DESK_RECORDER_HOME", str(tmp_path / "home"))
    return tmp_path / "home"
