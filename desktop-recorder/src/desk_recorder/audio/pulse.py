"""Linux backend (UNTESTED): PulseAudio / PipeWire via `parec`.

`parec` ships with pulseaudio-utils and works against PipeWire through
pipewire-pulse. The system side records the output sink's `.monitor`
source. Asking parec for 48 kHz float mono means no resampling here.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
from typing import Callable

import numpy as np

from desk_recorder.audio.base import AudioSourceError, DeviceInfo, MixerSource, StereoMixer
from desk_recorder.config import SAMPLE_RATE


def _pactl_short(kind: str) -> list[str]:
    out = subprocess.run(["pactl", "list", "short", kind], capture_output=True,
                         text=True, check=True, timeout=5).stdout
    return [line.split("\t")[1] for line in out.splitlines() if "\t" in line]


def list_devices() -> list[DeviceInfo]:
    sources = [s for s in _pactl_short("sources") if not s.endswith(".monitor")]
    sinks = _pactl_short("sinks")
    return [DeviceInfo(s, True) for s in sources] + [DeviceInfo(s, False) for s in sinks]


class PulseSource(MixerSource):
    BLOCK_BYTES = 4 * SAMPLE_RATE // 20  # 50 ms of float32 mono

    def __init__(self, mic_device: str = "", output_device: str = "") -> None:
        self.mic = mic_device or "@DEFAULT_SOURCE@"
        self.monitor = f"{output_device}.monitor" if output_device else "@DEFAULT_MONITOR@"
        self.mixer = StereoMixer(SAMPLE_RATE, 1, SAMPLE_RATE, 1)
        self._procs: list[subprocess.Popen] = []

    def _spawn(self, device: str, push: Callable[[np.ndarray], None]) -> None:
        proc = subprocess.Popen(
            ["parec", "--raw", "--format=float32le", f"--rate={SAMPLE_RATE}",
             "--channels=1", f"--device={device}"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self._procs.append(proc)

        def pump() -> None:
            assert proc.stdout is not None
            while True:
                data = proc.stdout.read(self.BLOCK_BYTES)
                if not data:
                    return
                usable = len(data) - len(data) % 4
                push(np.frombuffer(data[:usable], dtype=np.float32))

        threading.Thread(target=pump, daemon=True).start()

    def start(self) -> None:
        if not shutil.which("parec"):
            raise AudioSourceError("`parec` not found. Install pulseaudio-utils (works with PipeWire).")
        self._spawn(self.mic, self.mixer.push_mic)
        self._spawn(self.monitor, self.mixer.push_system)

    def stop(self) -> None:
        for proc in self._procs:
            proc.terminate()
        self._procs = []
