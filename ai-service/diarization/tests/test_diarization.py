"""
Diarization tests with a fake embedding engine and fake audio: no
sherpa-onnx, no model download, no audio decoding.

Fake audio: a float32 waveform where each speaker's speech is filled
with that speaker's marker (1.0, 2.0, ...). The fake engine maps the
dominant marker of the samples it gets to a fixed unit vector, plus a
little deterministic noise, so clustering sees realistic near-duplicates.
"""

from __future__ import annotations

import hashlib
import sys
import types

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from diarization import cluster, engines, models, pipeline
from diarization.routes import router

SR = 16_000
DIM = 16


def speaker_vector(marker: int, jitter: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(marker * 1000 + int(jitter * 1e6))
    base = np.zeros(DIM)
    base[marker % DIM] = 1.0
    return base + rng.normal(0, 0.05, DIM)


class FakeEngine:
    name = "fake"
    model = "fake-model"

    def __init__(self):
        self.calls = 0

    def is_loaded(self):
        return True

    def embed(self, samples):
        self.calls += 1
        values = np.round(np.asarray(samples)).astype(int)
        values = values[values > 0]
        marker = int(np.bincount(values).argmax()) if len(values) else 0
        return speaker_vector(marker, jitter=len(samples) / 1e7)


def timeline(*parts):
    """parts: (marker, seconds) -> waveform."""
    return np.concatenate([np.full(int(s * SR), m, dtype=np.float32) for m, s in parts])


@pytest.fixture()
def fake_audio(monkeypatch):
    holder = {}

    def fake_decode(path, channel_layout):
        holder["layout"] = channel_layout
        return holder["audio"]

    monkeypatch.setattr(pipeline, "decode", fake_decode)
    return holder


# ---- cluster.py ---------------------------------------------------------


def test_windows_short_segment_is_one_window():
    assert cluster.windows(1.0, 3.0) == [(1.0, 3.0)]


def test_windows_too_short_segment_is_skipped():
    assert cluster.windows(1.0, 1.3) == []


def test_windows_long_segment_overlaps_and_reaches_the_end():
    spans = cluster.windows(0.0, 7.0)
    assert spans[0] == (0.0, 3.0)
    assert spans[-1] == (4.0, 7.0)
    assert all(b - a == pytest.approx(3.0) for a, b in spans)


def test_agglomerate_groups_same_voice():
    vectors = [speaker_vector(1, 0.1), speaker_vector(2, 0.2), speaker_vector(1, 0.3)]
    assert cluster.agglomerate(vectors) == [0, 1, 0]


def test_agglomerate_numbers_by_first_appearance():
    vectors = [speaker_vector(3), speaker_vector(1), speaker_vector(3, 0.5)]
    assert cluster.agglomerate(vectors) == [0, 1, 0]


def test_agglomerate_empty():
    assert cluster.agglomerate([]) == []


def test_weighted_centroid_is_unit_length():
    centroid = cluster.weighted_centroid([speaker_vector(1), speaker_vector(1, 0.2)], [1, 3])
    assert np.linalg.norm(centroid) == pytest.approx(1.0)


# ---- pipeline.py --------------------------------------------------------


def test_two_speakers_become_two_clusters(fake_audio):
    fake_audio["audio"] = timeline((1, 4), (2, 3), (1, 2))
    result = pipeline.diarize_file(
        "x.webm",
        offset_ms=20_000,
        channel_layout="stereo-mic-left",
        segments=[
            {"startMs": 20_000, "endMs": 24_000},
            {"startMs": 24_000, "endMs": 27_000},
            {"startMs": 27_000, "endMs": 29_000},
        ],
        engine=FakeEngine(),
    )
    assert fake_audio["layout"] == "stereo-mic-left"
    members = [c["members"] for c in result["clusters"]]
    assert members == [[0, 2], [1]]
    assert result["clusters"][0]["speechMs"] == 6000
    assert result["skipped"] == []
    assert result["engine"] == "fake"
    assert len(result["clusters"][0]["centroid"]) == DIM


def test_short_segments_are_skipped_not_guessed(fake_audio):
    fake_audio["audio"] = timeline((1, 3), (2, 0.3))
    result = pipeline.diarize_file(
        "x.webm",
        0,
        "mono",
        [{"startMs": 0, "endMs": 3000}, {"startMs": 3000, "endMs": 3300}],
        engine=FakeEngine(),
    )
    assert result["skipped"] == [1]
    assert [c["members"] for c in result["clusters"]] == [[0]]


def test_segment_beyond_the_audio_is_clipped(fake_audio):
    fake_audio["audio"] = timeline((1, 2))
    result = pipeline.diarize_file(
        "x.webm", 0, "mono", [{"startMs": 1000, "endMs": 9000}], engine=FakeEngine()
    )
    assert result["clusters"][0]["speechMs"] == 1000


def test_pyannote_style_engine_maps_turns_by_overlap(fake_audio):
    fake_audio["audio"] = timeline((1, 6))

    class FakePyannote:
        name = "pyannote"
        model = "fake-pyannote"

        def diarize_waveform(self, samples):
            turns = [(0.0, 2.5, "A"), (2.5, 6.0, "B")]
            return turns, {"A": speaker_vector(1), "B": speaker_vector(2)}

    result = pipeline.diarize_file(
        "x.webm",
        0,
        "mono",
        [{"startMs": 0, "endMs": 2000}, {"startMs": 2200, "endMs": 5000}],
        engine=FakePyannote(),
    )
    assert sorted(c["members"] for c in result["clusters"]) == [[0], [1]]


# ---- routes.py ----------------------------------------------------------


@pytest.fixture()
def client(fake_audio, monkeypatch):
    engine = FakeEngine()
    engines.set_engine(engine)
    app = FastAPI()
    app.include_router(router)
    yield TestClient(app)
    engines.set_engine(None)


def test_route_returns_clusters(client, fake_audio, tmp_path):
    audio_file = tmp_path / "chunk.webm"
    audio_file.write_bytes(b"fake")
    fake_audio["audio"] = timeline((1, 3), (2, 3))
    res = client.post(
        "/diarize",
        json={
            "file_path": str(audio_file),
            "channel_layout": "stereo-mic-left",
            "segments": [{"startMs": 0, "endMs": 3000}, {"startMs": 3000, "endMs": 6000}],
        },
    )
    assert res.status_code == 200
    assert len(res.json()["clusters"]) == 2


def test_route_rejects_missing_file(client):
    res = client.post("/diarize", json={"file_path": "/no/such/file.webm", "segments": []})
    assert res.status_code == 400


def test_route_rejects_unknown_layout(client, tmp_path):
    audio_file = tmp_path / "chunk.webm"
    audio_file.write_bytes(b"fake")
    res = client.post("/diarize", json={"file_path": str(audio_file), "channel_layout": "5.1"})
    assert res.status_code == 400


def test_route_503_when_engine_unavailable(fake_audio, tmp_path, monkeypatch):
    class Broken:
        name = "sherpa"
        model = "m"

        def embed(self, samples):
            raise engines.EngineUnavailable("sherpa-onnx is not installed")

    engines.set_engine(Broken())
    try:
        app = FastAPI()
        app.include_router(router)
        audio_file = tmp_path / "chunk.webm"
        audio_file.write_bytes(b"fake")
        fake_audio["audio"] = timeline((1, 3))
        res = TestClient(app).post(
            "/diarize",
            json={"file_path": str(audio_file), "segments": [{"startMs": 0, "endMs": 3000}]},
        )
        assert res.status_code == 503
    finally:
        engines.set_engine(None)


def test_sherpa_engine_without_package_is_unavailable(monkeypatch):
    monkeypatch.setitem(sys.modules, "sherpa_onnx", None)
    engine = engines.SherpaEngine()
    with pytest.raises(engines.EngineUnavailable):
        engine.embed(np.zeros(SR, dtype=np.float32))
    assert engine.is_loaded() is False


def test_sherpa_engine_uses_the_extractor(monkeypatch, tmp_path):
    model_file = tmp_path / "m.onnx"
    model_file.write_bytes(b"onnx")
    received = {}

    class Config:
        def __init__(self, model, num_threads, provider):
            received.update(model=model, threads=num_threads)

        def validate(self):
            return True

    class Stream:
        def accept_waveform(self, sample_rate, waveform):
            received["sr"] = sample_rate
            received["n"] = len(waveform)

        def input_finished(self):
            received["finished"] = True

    class Extractor:
        def __init__(self, config):
            pass

        def create_stream(self):
            return Stream()

        def compute(self, stream):
            return [0.0, 1.0]

    fake = types.ModuleType("sherpa_onnx")
    fake.SpeakerEmbeddingExtractorConfig = Config
    fake.SpeakerEmbeddingExtractor = Extractor
    monkeypatch.setitem(sys.modules, "sherpa_onnx", fake)
    monkeypatch.setenv("SPEAKER_EMBEDDING_MODEL", str(model_file))

    engine = engines.SherpaEngine()
    vector = engine.embed(np.zeros(SR, dtype=np.float32))
    assert list(vector) == [0.0, 1.0]
    assert received == {
        "model": str(model_file),
        "threads": 1,
        "sr": SR,
        "n": SR,
        "finished": True,
    }


def test_unknown_engine_is_unavailable(monkeypatch):
    engines.set_engine(None)
    monkeypatch.setenv("DIARIZATION_ENGINE", "magic")
    with pytest.raises(engines.EngineUnavailable):
        engines.get_engine()
    engines.set_engine(None)


# ---- models.py ----------------------------------------------------------


def test_download_verifies_checksum_and_caches(monkeypatch, tmp_path):
    payload = b"weights"
    spec = models.ModelSpec(
        name="tiny",
        file="tiny.onnx",
        sha256=hashlib.sha256(payload).hexdigest(),
        size=len(payload),
        licence="test",
    )
    monkeypatch.setitem(models.MODELS, "tiny", spec)
    monkeypatch.setenv("SPEAKER_MODEL_DIR", str(tmp_path))
    fetched = []

    def fetch(url, path):
        fetched.append(url)
        with open(path, "wb") as handle:
            handle.write(payload)

    first = models.resolve_model("tiny", fetch=fetch)
    second = models.resolve_model("tiny", fetch=fetch)
    assert first == second == tmp_path / "tiny.onnx"
    assert fetched == [f"{models.RELEASE_URL}/tiny.onnx"]


def test_download_with_bad_checksum_leaves_nothing(monkeypatch, tmp_path):
    spec = models.ModelSpec("bad", "bad.onnx", "0" * 64, 1, "test")
    monkeypatch.setitem(models.MODELS, "bad", spec)
    monkeypatch.setenv("SPEAKER_MODEL_DIR", str(tmp_path))

    def fetch(url, path):
        with open(path, "wb") as handle:
            handle.write(b"tampered")

    with pytest.raises(RuntimeError, match="Checksum mismatch"):
        models.resolve_model("bad", fetch=fetch)
    assert list(tmp_path.iterdir()) == []


def test_unknown_model_name():
    with pytest.raises(ValueError):
        models.resolve_model("nope", fetch=lambda *_: None)


def test_default_model_is_registered_with_a_permissive_licence():
    spec = models.MODELS[models.DEFAULT_MODEL]
    assert spec.url.startswith("https://github.com/k2-fsa/sherpa-onnx/releases/download/")
    assert spec.licence.startswith("CC BY 4.0")


def test_main_registers_the_routes():
    import main

    paths = set(main.app.openapi()["paths"])
    assert {"/diarize", "/diarize/health", "/transcribe"} <= paths
