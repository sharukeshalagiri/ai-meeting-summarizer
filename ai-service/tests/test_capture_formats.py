"""
The capture contract's audio formats decode as stereo 48 kHz.

docs/CAPTURE_CONTRACT.md accepts Opus, 48 kHz, stereo, in audio/webm
(the extension) or audio/ogg (the desktop recorder). faster-whisper
decodes with PyAV (`av.open`), so that is what this opens. If either
container came out mono or resampled, the per-channel split (left = mic,
right = everyone else) would silently attribute everything to one side.

ffmpeg generates the files in a temp dir (nothing is committed): a
different sine tone per channel, merged to stereo, 1 s, libopus. The
test skips cleanly when ffmpeg or PyAV is not installed.
"""

import shutil
import subprocess

import pytest

av = pytest.importorskip("av")

FFMPEG = shutil.which("ffmpeg")

pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not on PATH")

SAMPLE_RATE = 48_000


def make_chunk(path):
    """1 s of stereo Opus: 440 Hz on the left, 880 Hz on the right."""
    subprocess.run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate={SAMPLE_RATE}:duration=1",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=880:sample_rate={SAMPLE_RATE}:duration=1",
            "-filter_complex",
            "[0:a][1:a]amerge=inputs=2[a]",
            "-map",
            "[a]",
            "-ac",
            "2",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "libopus",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


@pytest.mark.parametrize("extension", ["webm", "ogg"])
def test_contract_format_decodes_as_stereo_48k(tmp_path, extension):
    path = tmp_path / f"chunk.{extension}"

    try:
        make_chunk(path)
    except subprocess.CalledProcessError as error:
        stderr = error.stderr.decode(errors="replace")
        if "libopus" in stderr or "Unknown encoder" in stderr:
            pytest.skip("this ffmpeg build has no libopus encoder")
        raise

    with av.open(str(path)) as container:
        stream = container.streams.audio[0]

        assert stream.codec_context.name == "opus"
        assert stream.codec_context.channels == 2
        assert stream.codec_context.sample_rate == SAMPLE_RATE

        frames = list(container.decode(stream))

    assert frames, "no audio frames decoded"
    for frame in frames:
        assert len(frame.layout.channels) == 2
        assert frame.sample_rate == SAMPLE_RATE
