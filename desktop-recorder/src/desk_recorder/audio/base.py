"""The AudioSource interface and the stereo mixer every backend shares.

A platform backend opens two device streams, the microphone and the
system output (loopback / monitor), and pushes raw blocks from their
callbacks into a StereoMixer. The mixer downmixes each side to mono,
resamples it to SAMPLE_RATE and interleaves them as
LEFT = mic, RIGHT = system. Keeping that logic here (not in each backend)
is what lets a synthetic test prove the channel mapping without devices.
"""

from __future__ import annotations

import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np

from desk_recorder.config import SAMPLE_RATE


@dataclass(frozen=True)
class DeviceInfo:
    name: str
    is_input: bool
    is_default: bool = False


class AudioSourceError(RuntimeError):
    """A capture backend cannot start; the message is shown to the user."""


class AudioSource(ABC):
    """Stereo capture: LEFT = microphone, RIGHT = system audio.

    `read(frames)` blocks until `frames` stereo samples at SAMPLE_RATE are
    available (or the timeout passes) and returns a float32 (n, 2) array.
    """

    sample_rate: int = SAMPLE_RATE

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def read(self, frames: int, timeout: float | None = None) -> np.ndarray: ...

    @abstractmethod
    def stop(self) -> None: ...


def to_mono(block: np.ndarray, channels: int) -> np.ndarray:
    """Interleaved (or 2-D) samples -> float32 mono by averaging channels."""
    data = np.asarray(block, dtype=np.float32)
    if data.ndim == 1 and channels > 1:
        usable = len(data) - len(data) % channels
        data = data[:usable].reshape(-1, channels)
    if data.ndim == 2:
        data = data.mean(axis=1)
    return data.astype(np.float32, copy=False)


class LinearResampler:
    """Streaming linear-interpolation resampler.

    Keeps the fractional read position across blocks so block boundaries
    don't click. Linear interpolation is enough for speech going to
    Whisper (which resamples to 16 kHz anyway); a polyphase filter would
    add scipy (~40 MB) to the bundle for no audible gain here.
    """

    def __init__(self, src_rate: int, dst_rate: int) -> None:
        self.src_rate = src_rate
        self.dst_rate = dst_rate
        self._step = src_rate / dst_rate
        self._buf = np.zeros(0, dtype=np.float32)
        self._pos = 0.0

    def process(self, x: np.ndarray) -> np.ndarray:
        if self.src_rate == self.dst_rate:
            return np.asarray(x, dtype=np.float32)
        buf = np.concatenate([self._buf, np.asarray(x, dtype=np.float32)])
        if len(buf) < 2:
            self._buf = buf
            return np.zeros(0, dtype=np.float32)
        last = len(buf) - 1
        count = int(np.floor((last - self._pos) / self._step)) + 1
        if count <= 0:
            self._buf = buf
            return np.zeros(0, dtype=np.float32)
        positions = self._pos + self._step * np.arange(count)
        out = np.interp(positions, np.arange(len(buf)), buf).astype(np.float32)
        next_pos = self._pos + self._step * count
        keep_from = int(np.floor(next_pos))
        self._buf = buf[keep_from:]
        self._pos = next_pos - keep_from
        return out


class StereoMixer:
    """Aligns the two device streams into one stereo stream.

    The microphone drives the clock: it delivers continuously, while
    WASAPI loopback goes quiet when nothing is playing. When `read` takes
    N mic samples it takes up to N system samples and pads the front with
    silence. If the system side runs ahead (its device clock is a little
    faster than the mic's), its backlog is trimmed to MAX_SYSTEM_LAG_S so
    the two channels never drift apart by more than that.
    """

    MAX_SYSTEM_LAG_S = 0.5

    def __init__(self, mic_rate: int, mic_channels: int,
                 system_rate: int, system_channels: int,
                 rate: int = SAMPLE_RATE) -> None:
        self.rate = rate
        self._mic_channels = mic_channels
        self._sys_channels = system_channels
        self._mic_rs = LinearResampler(mic_rate, rate)
        self._sys_rs = LinearResampler(system_rate, rate)
        self._mic: list[np.ndarray] = []
        self._sys: list[np.ndarray] = []
        self._mic_len = 0
        self._sys_len = 0
        self._cond = threading.Condition()
        self._max_sys = int(self.MAX_SYSTEM_LAG_S * rate)

    def push_mic(self, block: np.ndarray) -> None:
        data = self._mic_rs.process(to_mono(block, self._mic_channels))
        with self._cond:
            self._mic.append(data)
            self._mic_len += len(data)
            self._cond.notify_all()

    def push_system(self, block: np.ndarray) -> None:
        data = self._sys_rs.process(to_mono(block, self._sys_channels))
        with self._cond:
            self._sys.append(data)
            self._sys_len += len(data)
            self._cond.notify_all()

    @staticmethod
    def _take(chunks: list[np.ndarray], n: int) -> np.ndarray:
        """Pop up to n samples from the front of a list of arrays."""
        out: list[np.ndarray] = []
        need = n
        while need > 0 and chunks:
            head = chunks[0]
            if len(head) <= need:
                out.append(head)
                chunks.pop(0)
                need -= len(head)
            else:
                out.append(head[:need])
                chunks[0] = head[need:]
                need = 0
        return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)

    def read(self, frames: int, timeout: float | None = None) -> np.ndarray:
        """Up to `frames` stereo samples; fewer only if the timeout passes."""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            while self._mic_len < frames:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    break
                self._cond.wait(remaining)
            n = min(frames, self._mic_len)
            mic = self._take(self._mic, n)
            self._mic_len -= len(mic)
            if self._sys_len > n + self._max_sys:
                drop = self._sys_len - n - self._max_sys
                self._sys_len -= len(self._take(self._sys, drop))
            sys_part = self._take(self._sys, n)
            self._sys_len -= len(sys_part)
        # Right-align a short system block: the samples we do have arrived
        # most recently, so they belong at the end of this window. Left-
        # aligning would shift speech up to one read (0.25 s) early each
        # time loopback resumes after silence.
        system = np.zeros(n, dtype=np.float32)
        if len(sys_part):
            system[n - len(sys_part):] = sys_part
        return np.stack([mic, system], axis=1)


class MixerSource(AudioSource):
    """Base for backends: subclasses open devices that feed self.mixer."""

    mixer: StereoMixer

    def read(self, frames: int, timeout: float | None = None) -> np.ndarray:
        return self.mixer.read(frames, timeout)
