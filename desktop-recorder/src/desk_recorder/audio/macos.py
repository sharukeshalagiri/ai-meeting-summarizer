"""macOS backend (UNTESTED): microphone + BlackHole.

macOS has no loopback API for third-party apps without a virtual device.
The user installs BlackHole 2ch and creates a Multi-Output Device
(speakers + BlackHole) in Audio MIDI Setup, so they still hear the call
while BlackHole carries a copy to us. `blackhole_status()` checks the
first half; the README has the steps.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from desk_recorder.audio.base import AudioSourceError, DeviceInfo, MixerSource, StereoMixer

SETUP_HINT = ("Install BlackHole 2ch (brew install blackhole-2ch), then in Audio MIDI Setup "
              "create a Multi-Output Device with your speakers + BlackHole and make it the output.")


def _sd() -> Any:
    try:
        import sounddevice as sd  # type: ignore[import-not-found]
    except ImportError as exc:
        raise AudioSourceError("sounddevice is not installed. Run: pip install -r requirements.txt") from exc
    return sd


def blackhole_status() -> str | None:
    """None when BlackHole is present, otherwise what the user must do."""
    sd = _sd()
    if any("blackhole" in d["name"].lower() for d in sd.query_devices()):
        return None
    return SETUP_HINT


def list_devices() -> list[DeviceInfo]:
    sd = _sd()
    default_in = sd.default.device[0]
    return [DeviceInfo(d["name"], True, i == default_in)
            for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]


class BlackHoleSource(MixerSource):
    def __init__(self, mic_device: str = "") -> None:
        self.mic_device = mic_device
        self._streams: list[Any] = []

    def start(self) -> None:
        sd = _sd()
        problem = blackhole_status()
        if problem:
            raise AudioSourceError(problem)
        devices = list(sd.query_devices())
        bh = next(i for i, d in enumerate(devices) if "blackhole" in d["name"].lower())
        mic = sd.default.device[0]
        if self.mic_device:
            mic = next((i for i, d in enumerate(devices)
                        if d["name"] == self.mic_device and d["max_input_channels"] > 0), mic)
        mic_rate = int(devices[mic]["default_samplerate"])
        bh_rate = int(devices[bh]["default_samplerate"])
        self.mixer = StereoMixer(mic_rate, 1, bh_rate, 2)

        def cb(push):
            def inner(indata, frames, time_info, status):  # noqa: ARG001
                push(np.array(indata, dtype=np.float32))
            return inner

        try:
            for dev, rate, ch, push in ((mic, mic_rate, 1, self.mixer.push_mic),
                                        (bh, bh_rate, 2, self.mixer.push_system)):
                stream = sd.InputStream(device=dev, samplerate=rate, channels=ch,
                                        dtype="float32", callback=cb(push))
                stream.start()
                self._streams.append(stream)
        except Exception as exc:  # noqa: BLE001
            self.stop()
            raise AudioSourceError(f"Could not open audio devices: {exc}") from exc

    def stop(self) -> None:
        for s in self._streams:
            try:
                s.stop()
                s.close()
            except Exception:  # noqa: BLE001
                pass
        self._streams = []
