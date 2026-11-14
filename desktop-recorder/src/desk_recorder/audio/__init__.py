"""Capture backends behind one AudioSource interface.

Windows: WASAPI loopback (pyaudiowpatch). Linux: PulseAudio/PipeWire
monitor via `parec` (untested). macOS: BlackHole (untested).
Backend modules import their native packages lazily, so the rest of the
app (and the tests) load on any OS.
"""

from __future__ import annotations

import sys

from desk_recorder.audio.base import AudioSource, AudioSourceError, DeviceInfo


def create_source(mic_device: str = "", output_device: str = "",
                  fake: bool = False) -> AudioSource:
    if fake:
        from desk_recorder.audio.fake import FakeSource
        return FakeSource(realtime=True)
    if sys.platform == "win32":
        from desk_recorder.audio.wasapi import WasapiSource
        return WasapiSource(mic_device, output_device)
    if sys.platform == "darwin":
        from desk_recorder.audio.macos import BlackHoleSource
        return BlackHoleSource(mic_device)
    from desk_recorder.audio.pulse import PulseSource
    return PulseSource(mic_device, output_device)


def list_devices() -> list[DeviceInfo]:
    """Inputs (mics) and outputs (what to capture) for the settings pickers."""
    try:
        if sys.platform == "win32":
            from desk_recorder.audio.wasapi import list_devices as impl
        elif sys.platform == "darwin":
            from desk_recorder.audio.macos import list_devices as impl
        else:
            from desk_recorder.audio.pulse import list_devices as impl
        return impl()
    except Exception:  # noqa: BLE001 - a broken audio stack must not crash settings
        return []


__all__ = ["AudioSource", "AudioSourceError", "DeviceInfo", "create_source", "list_devices"]
