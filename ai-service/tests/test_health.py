"""
/health must answer without a Whisper model.

A fake `whisper` module is installed before `main` is imported, so the
tests need neither torch nor a model download, and they fail loudly if
anything tries to load a model.
"""

import sys
import types

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app_module(monkeypatch):
    calls = []

    fake_whisper = types.ModuleType("whisper")
    fake_whisper.load_model = lambda name: calls.append(name)

    monkeypatch.setitem(sys.modules, "whisper", fake_whisper)
    monkeypatch.setenv("WHISPER_MODEL", "tiny")
    # Re-import each time so env and the fake module apply.
    monkeypatch.delitem(sys.modules, "main", raising=False)

    import main

    main.load_calls = calls
    return main


def test_health_ok_without_loading_model(app_module):
    client = TestClient(app_module.app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "model": "tiny", "loaded": False}
    assert app_module.load_calls == []


def test_transcribe_rejects_missing_file_without_loading_model(app_module, tmp_path):
    client = TestClient(app_module.app)

    response = client.post(
        "/transcribe", json={"file_path": str(tmp_path / "missing.webm")}
    )

    assert response.status_code == 400
    assert app_module.load_calls == []
