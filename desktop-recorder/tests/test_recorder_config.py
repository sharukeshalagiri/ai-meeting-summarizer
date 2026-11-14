"""Chunking (seq + offsets from the sample clock) and settings."""

from __future__ import annotations

import json

import numpy as np
import soundfile as sf

from desk_recorder import config
from desk_recorder.audio.fake import FakeSource
from desk_recorder.chunk_queue import ChunkQueue
from desk_recorder.config import SAMPLE_RATE, Settings
from desk_recorder.recorder import Recorder


def test_provisional_format_constants():
    # Pending engineer decision (option 1); must match the extension.
    assert config.CHUNK_MS == 20_000
    assert config.ENCODING == "ogg-opus"
    assert config.SAMPLE_RATE == 48_000
    assert config.CHANNEL_LAYOUT == "stereo-mic-left"


def test_chunks_are_numbered_with_contiguous_offsets(tmp_path):
    q = ChunkQueue(tmp_path / "q")
    s = q.new_session("t")
    rec = Recorder(FakeSource(), q, s.local_id, chunk_ms=2_000)
    src = rec.source
    src.start()
    for _ in range(22):  # 5.5 s in 0.25 s reads
        rec.feed(src.read(SAMPLE_RATE // 4))
    rec.flush()
    chunks = q.chunks(s.local_id)
    assert [c.seq for c in chunks] == [0, 1, 2]
    assert [c.start_offset_ms for c in chunks] == [0, 2000, 4000]
    assert [c.duration_ms for c in chunks] == [2000, 2000, 1500]
    assert all(c.channel_layout == "stereo-mic-left" and c.mime_type == "audio/ogg" for c in chunks)
    data, rate = sf.read(str(q.audio_path(s.local_id, chunks[0])))
    assert rate == SAMPLE_RATE and data.shape == (2 * SAMPLE_RATE, 2)
    assert not list((q.root / s.local_id).glob("*.part*"))


def test_tiny_final_chunk_is_dropped(tmp_path):
    q = ChunkQueue(tmp_path / "q")
    s = q.new_session("t")
    rec = Recorder(FakeSource(), q, s.local_id, chunk_ms=1_000)
    rec.feed(np.zeros((SAMPLE_RATE // 10, 2), dtype=np.float32))
    rec.flush()
    assert q.chunks(s.local_id) == []


def test_recorder_thread_start_stop(tmp_path):
    q = ChunkQueue(tmp_path / "q")
    s = q.new_session("t")
    rec = Recorder(FakeSource(), q, s.local_id, chunk_ms=1_000)
    rec.start()
    import time
    deadline = time.time() + 10
    while not q.chunks(s.local_id) and time.time() < deadline:
        time.sleep(0.05)
    rec.stop()
    assert q.chunks(s.local_id)


def test_settings_roundtrip_and_defaults(home):
    assert Settings.load().api_url == "http://localhost:5000/api"
    s = Settings(device_token="tok", mode="LECTURE", hints=["Kubernetes"])
    s.save()
    loaded = Settings.load()
    assert loaded.device_token == "tok" and loaded.mode == "LECTURE" and loaded.hints == ["Kubernetes"]


def test_settings_ignore_garbage(home):
    home.mkdir(parents=True)
    (home / "settings.json").write_text(json.dumps({"mode": "BOGUS", "unknown": 1, "hints": "x"}))
    loaded = Settings.load()
    assert loaded.mode == "AUTO" and loaded.hints == []
    (home / "settings.json").write_text("{not json")
    assert Settings.load() == Settings()
