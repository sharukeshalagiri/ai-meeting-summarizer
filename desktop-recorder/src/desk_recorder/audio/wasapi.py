"""Windows backend: microphone + WASAPI loopback of an output device.

pyaudiowpatch is a PyAudio fork whose PortAudio build exposes every
output device as a "[Loopback]" input, so system audio is captured
without a virtual cable or Stereo Mix. Both streams run in shared mode at
the device's native rate and channel count; the StereoMixer converts.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from desk_recorder.audio.base import AudioSourceError, DeviceInfo, MixerSource, StereoMixer


def _pyaudio() -> Any:
    try:
        import pyaudiowpatch as pyaudio  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - Windows only
        raise AudioSourceError(
            "PyAudioWPatch is not installed. Run: pip install -r requirements.txt") from exc
    return pyaudio


def _wasapi_devices(p: Any, pyaudio: Any) -> tuple[dict, list[dict]]:
    api = p.get_host_api_info_by_type(pyaudio.paWASAPI)
    devices = [p.get_device_info_by_host_api_device_index(api["index"], i)
               for i in range(api["deviceCount"])]
    return api, devices


def list_devices() -> list[DeviceInfo]:
    pyaudio = _pyaudio()
    p = pyaudio.PyAudio()
    try:
        api, devices = _wasapi_devices(p, pyaudio)
        out: list[DeviceInfo] = []
        for d in devices:
            if d.get("isLoopbackDevice"):
                continue
            if d["maxInputChannels"] > 0:
                out.append(DeviceInfo(d["name"], True, d["index"] == api["defaultInputDevice"]))
            if d["maxOutputChannels"] > 0:
                out.append(DeviceInfo(d["name"], False, d["index"] == api["defaultOutputDevice"]))
        return out
    finally:
        p.terminate()


class WasapiSource(MixerSource):
    FRAMES_PER_BUFFER_S = 0.05

    def __init__(self, mic_device: str = "", output_device: str = "") -> None:
        self.mic_device = mic_device
        self.output_device = output_device
        self._p: Any = None
        self._streams: list[Any] = []

    def _find_mic(self, api: dict, devices: list[dict]) -> dict:
        if self.mic_device:
            for d in devices:
                if (d["name"] == self.mic_device and d["maxInputChannels"] > 0
                        and not d.get("isLoopbackDevice")):
                    return d
        for d in devices:
            if d["index"] == api["defaultInputDevice"]:
                return d
        raise AudioSourceError("No microphone found. Plug one in or pick it in Settings.")

    def _find_loopback(self, api: dict, devices: list[dict]) -> dict:
        target = self.output_device
        if not target:
            for d in devices:
                if d["index"] == api["defaultOutputDevice"]:
                    target = d["name"]
        for d in devices:
            if d.get("isLoopbackDevice") and target and d["name"].startswith(target):
                return d
        raise AudioSourceError(
            f"No loopback device for output '{target or 'default'}'. Pick another output in Settings.")

    def start(self) -> None:
        pyaudio = _pyaudio()
        self._p = pyaudio.PyAudio()
        try:
            api, devices = _wasapi_devices(self._p, pyaudio)
            mic = self._find_mic(api, devices)
            loop = self._find_loopback(api, devices)
            mic_rate = int(mic["defaultSampleRate"])
            mic_ch = max(1, min(2, int(mic["maxInputChannels"])))
            sys_rate = int(loop["defaultSampleRate"])
            sys_ch = max(1, int(loop["maxInputChannels"]))
            self.mixer = StereoMixer(mic_rate, mic_ch, sys_rate, sys_ch)

            def callback(push):
                def cb(in_data, frame_count, time_info, status):  # noqa: ARG001
                    push(np.frombuffer(in_data, dtype=np.float32))
                    return (None, pyaudio.paContinue)
                return cb

            for dev, rate, ch, push in (
                (mic, mic_rate, mic_ch, self.mixer.push_mic),
                (loop, sys_rate, sys_ch, self.mixer.push_system),
            ):
                stream = self._p.open(
                    format=pyaudio.paFloat32, channels=ch, rate=rate, input=True,
                    input_device_index=dev["index"],
                    frames_per_buffer=int(rate * self.FRAMES_PER_BUFFER_S),
                    stream_callback=callback(push))
                self._streams.append(stream)
        except AudioSourceError:
            self.stop()
            raise
        except Exception as exc:  # noqa: BLE001 - PortAudio raises OSError variants
            self.stop()
            raise AudioSourceError(f"Could not open audio devices: {exc}") from exc

    def stop(self) -> None:
        for s in self._streams:
            try:
                s.stop_stream()
                s.close()
            except Exception:  # noqa: BLE001
                pass
        self._streams = []
        if self._p is not None:
            self._p.terminate()
            self._p = None
