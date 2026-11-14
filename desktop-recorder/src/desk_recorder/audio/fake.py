"""Synthetic AudioSource: sine tones instead of devices.

Used by the tests (no sound card in CI) and by `--fake-audio` for
trying the tray and upload path without capturing anything real. It
goes through the same StereoMixer as the real backends, with native
rates and channel counts chosen to exercise resampling and downmixing.
"""

from __future__ import annotations

import time

import numpy as np

from desk_recorder.audio.base import MixerSource, StereoMixer


class FakeSource(MixerSource):
    BLOCK_S = 0.01

    def __init__(self, mic_hz: float | None = 440.0, system_hz: float | None = 1000.0,
                 mic_rate: int = 44_100, mic_channels: int = 1,
                 system_rate: int = 48_000, system_channels: int = 2,
                 amplitude: float = 0.5, realtime: bool = False,
                 system_gap: tuple[float, float] | None = None) -> None:
        """`system_gap=(start_s, end_s)` makes the system side deliver
        nothing in that window, like WASAPI loopback during silence."""
        self.mic_hz = mic_hz
        self.system_hz = system_hz
        self.mic_rate = mic_rate
        self.mic_channels = mic_channels
        self.system_rate = system_rate
        self.system_channels = system_channels
        self.amplitude = amplitude
        self.realtime = realtime
        self.system_gap = system_gap
        self.mixer = StereoMixer(mic_rate, mic_channels, system_rate, system_channels)
        self._t = 0.0
        self._started_at = 0.0
        self._running = False

    def _tone(self, hz: float | None, rate: int, channels: int) -> np.ndarray:
        n = int(round(self.BLOCK_S * rate))
        if hz is None:
            mono = np.zeros(n, dtype=np.float32)
        else:
            t = self._t + np.arange(n) / rate
            mono = (self.amplitude * np.sin(2 * np.pi * hz * t)).astype(np.float32)
        return np.repeat(mono[:, None], channels, axis=1).reshape(-1)

    def _push_block(self) -> None:
        self.mixer.push_mic(self._tone(self.mic_hz, self.mic_rate, self.mic_channels))
        in_gap = self.system_gap is not None and self.system_gap[0] <= self._t < self.system_gap[1]
        if not in_gap:
            self.mixer.push_system(
                self._tone(self.system_hz, self.system_rate, self.system_channels))
        self._t += self.BLOCK_S

    def start(self) -> None:
        self._running = True
        self._started_at = time.monotonic()

    def read(self, frames: int, timeout: float | None = None) -> np.ndarray:
        # Generate on demand: push blocks until the mixer can serve `frames`.
        while self.mixer._mic_len < frames and self._running:
            if self.realtime:
                ahead = self._t - (time.monotonic() - self._started_at)
                if ahead > 0:
                    time.sleep(min(ahead, 0.05))
                    continue
            self._push_block()
        return self.mixer.read(frames, timeout=0 if not self._running else timeout)

    def stop(self) -> None:
        self._running = False
