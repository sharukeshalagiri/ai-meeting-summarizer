"""
/health must answer without a Whisper model.

The fake `faster_whisper` module (conftest.py) is installed before
`main` is imported, so the tests need neither CTranslate2 nor a model
download, and they fail loudly if anything tries to load a model.
"""

from fastapi.testclient import TestClient


def test_health_ok_without_loading_model(app_module):
    client = TestClient(app_module.app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "model": "tiny", "loaded": False}
    assert app_module.fake.loads == []


def test_transcribe_rejects_missing_file_without_loading_model(app_module, tmp_path):
    client = TestClient(app_module.app)

    response = client.post(
        "/transcribe", json={"file_path": str(tmp_path / "missing.webm")}
    )

    assert response.status_code == 400
    assert app_module.fake.loads == []


def test_model_loads_once_on_cpu_int8_and_health_reports_it(app_module, tmp_path):
    from conftest import seg, write_audio

    app_module.fake.scripts[0.1] = [seg("hello there", 0.0, 1.0)]
    audio = write_audio(tmp_path / "a.json", (0.1, 2))
    client = TestClient(app_module.app)

    for _ in range(2):
        assert client.post("/transcribe", json={"file_path": str(audio)}).status_code == 200

    assert app_module.fake.loads == [
        {"name": "tiny", "device": "cpu", "compute_type": "int8"}
    ]
    assert client.get("/health").json()["loaded"] is True


def test_vad_and_word_timestamps_are_on(app_module, tmp_path):
    from conftest import write_audio

    audio = write_audio(tmp_path / "a.json", (0.1, 2))
    TestClient(app_module.app).post("/transcribe", json={"file_path": str(audio)})

    call = app_module.fake.calls[0]
    assert call["vad_filter"] is True
    assert call["word_timestamps"] is True
    assert call["language"] is None
