"""Channel mapping: a tone on one input lands only in its channel.

Synthetic: FakeSource feeds the same StereoMixer the device backends use,
at different native rates and channel counts than the output, so the
downmix + resample path is exercised too.
"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from conftest import band_energy, dominant_hz
from desk_recorder.audio.base import LinearResampler, StereoMixer, to_mono
from desk_recorder.audio.fake import FakeSource
from desk_recorder.config import SAMPLE_RATE
from desk_recorder.encoder import get_encoder

MIC_HZ, SYS_HZ = 440.0, 1000.0


def record(source: FakeSource, seconds: float) -> np.ndarray:
    source.start()
    frames = source.read(int(SAMPLE_RATE * seconds))
    source.stop()
    return frames


def assert_isolated(left: np.ndarray, right: np.ndarray, rate: int, ratio: float = 1000.0) -> None:
    """Mic tone dominates left and is ~absent on right, and vice versa."""
    assert dominant_hz(left, rate) == pytest.approx(MIC_HZ, abs=5)
    assert dominant_hz(right, rate) == pytest.approx(SYS_HZ, abs=5)
    assert band_energy(left, rate, MIC_HZ) > ratio * band_energy(right, rate, MIC_HZ)
    assert band_energy(right, rate, SYS_HZ) > ratio * band_energy(left, rate, SYS_HZ)


def test_mic_tone_left_system_tone_right():
    frames = record(FakeSource(mic_hz=MIC_HZ, system_hz=SYS_HZ), 2.0)
    assert frames.shape == (2 * SAMPLE_RATE, 2)
    assert_isolated(frames[:, 0], frames[:, 1], SAMPLE_RATE)


def test_mic_only_leaves_right_channel_silent():
    frames = record(FakeSource(mic_hz=MIC_HZ, system_hz=None), 1.0)
    assert np.abs(frames[:, 0]).max() > 0.3
    assert np.abs(frames[:, 1]).max() == 0.0


def test_system_only_leaves_left_channel_silent():
    frames = record(FakeSource(mic_hz=None, system_hz=SYS_HZ), 1.0)
    assert np.abs(frames[:, 0]).max() == 0.0
    assert np.abs(frames[:, 1]).max() > 0.3


@pytest.mark.parametrize("encoding", ["ogg-opus", "wav"])
def test_channels_survive_encoding(tmp_path, encoding):
    frames = record(FakeSource(mic_hz=MIC_HZ, system_hz=SYS_HZ), 2.0)
    enc = get_encoder(encoding)
    path = tmp_path / f"chunk{enc.extension}"
    enc.encode(frames, SAMPLE_RATE, path)
    decoded, rate = sf.read(str(path), dtype="float32")
    assert rate == SAMPLE_RATE
    assert decoded.ndim == 2 and decoded.shape[1] == 2
    # Opus is lossy; still expect >30 dB separation between channels.
    assert_isolated(decoded[:, 0], decoded[:, 1], rate, ratio=1000.0)


def test_opus_chunk_is_small(tmp_path):
    frames = record(FakeSource(), 20.0)
    path = tmp_path / "c.ogg"
    get_encoder("ogg-opus").encode(frames, SAMPLE_RATE, path)
    assert path.stat().st_size < 1_000_000


def test_loopback_gap_is_padded_with_silence_and_stays_aligned():
    # WASAPI loopback delivers nothing while nothing plays. Read in the
    # recorder's 0.25 s steps: the mixer pads whatever is missing *now*.
    source = FakeSource(system_gap=(0.5, 1.0))
    source.start()
    frames = np.concatenate([source.read(SAMPLE_RATE // 4) for _ in range(8)])
    right = frames[:, 1]
    gap = right[int(0.55 * SAMPLE_RATE):int(0.95 * SAMPLE_RATE)]
    assert np.abs(gap).max() == 0.0
    after = right[int(1.1 * SAMPLE_RATE):]
    assert dominant_hz(after, SAMPLE_RATE) == pytest.approx(SYS_HZ, abs=5)
    assert len(frames) == 2 * SAMPLE_RATE


def test_system_backlog_is_trimmed_to_max_lag():
    mixer = StereoMixer(SAMPLE_RATE, 1, SAMPLE_RATE, 1)
    mixer.push_system(np.ones(SAMPLE_RATE * 3, dtype=np.float32))
    mixer.push_mic(np.zeros(SAMPLE_RATE, dtype=np.float32))
    mixer.read(SAMPLE_RATE, timeout=0)
    assert mixer._sys_len <= int(StereoMixer.MAX_SYSTEM_LAG_S * SAMPLE_RATE)


def test_read_times_out_with_partial_data():
    mixer = StereoMixer(SAMPLE_RATE, 1, SAMPLE_RATE, 1)
    mixer.push_mic(np.zeros(100, dtype=np.float32))
    assert mixer.read(1000, timeout=0.01).shape == (100, 2)


def test_resampler_preserves_frequency_and_length_across_blocks():
    src = 44_100
    t = np.arange(src * 2) / src
    tone = np.sin(2 * np.pi * 440 * t).astype(np.float32)
    rs = LinearResampler(src, SAMPLE_RATE)
    out = np.concatenate([rs.process(b) for b in np.array_split(tone, 37)])
    assert abs(len(out) - 2 * SAMPLE_RATE) <= 2
    assert dominant_hz(out, SAMPLE_RATE) == pytest.approx(440, abs=2)
    # No clicks at block boundaries: sample-to-sample steps stay small.
    assert np.abs(np.diff(out)).max() < 0.07


def test_to_mono_averages_interleaved_channels():
    interleaved = np.array([1.0, 0.0, 0.5, 0.5], dtype=np.float32)
    assert to_mono(interleaved, 2).tolist() == [0.5, 0.5]
