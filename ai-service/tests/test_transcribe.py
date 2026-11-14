"""/transcribe end to end against the fake faster_whisper."""

import json

from fastapi.testclient import TestClient

from conftest import seg, write_audio


def test_json_request_returns_segments_with_words_and_offset(app_module, tmp_path):
    app_module.fake.scripts[0.1] = [
        seg("Hello there.", 0.5, 1.5, words=[(" Hello", 0.5, 1.0, 0.9), (" there.", 1.0, 1.5, 0.8)]),
    ]
    audio = write_audio(tmp_path / "a.json", (0.1, 10))

    response = TestClient(app_module.app).post(
        "/transcribe", json={"file_path": str(audio), "offset_ms": 60000}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "Hello there."
    assert body["durationMs"] == 10000
    assert body["language"] == "en"
    assert body["segments"] == [
        {
            "text": "Hello there.",
            "startMs": 60500,
            "endMs": 61500,
            "noSpeechProb": 0.05,
            "channel": None,
            "words": [
                {"w": "Hello", "startMs": 60500, "endMs": 61000, "p": 0.9},
                {"w": "there.", "startMs": 61000, "endMs": 61500, "p": 0.8},
            ],
        }
    ]


def test_multipart_upload_is_accepted_and_temp_file_removed(app_module, tmp_path, monkeypatch):
    app_module.fake.scripts[0.1] = [seg("uploaded audio", 1.0, 2.0)]
    audio = write_audio(tmp_path / "a.json", (0.1, 5))

    seen = []
    import asr.pipeline as pipeline

    real = pipeline.transcribe_file

    def spy(path, **kwargs):
        seen.append((path, kwargs))
        return real(path, **kwargs)

    monkeypatch.setattr(app_module, "transcribe_file", spy)

    with open(audio, "rb") as f:
        response = TestClient(app_module.app).post(
            "/transcribe",
            files={"audio": ("chunk.webm", f, "audio/webm")},
            data={
                "offset_ms": "1000",
                "channel_layout": "mono",
                "hints": ["Priya", "Kubernetes"],
            },
        )

    assert response.status_code == 200, response.text
    assert response.json()["segments"][0]["startMs"] == 2000
    path, kwargs = seen[0]
    assert path.endswith(".webm")
    assert kwargs["hints"] == ["Priya", "Kubernetes"]
    # Temp copy deleted after the request.
    import os

    assert not os.path.exists(path)
    assert app_module.fake.calls[0]["initial_prompt"] == "Glossary: Priya, Kubernetes."


def test_multipart_without_audio_is_400(app_module):
    response = TestClient(app_module.app).post(
        "/transcribe", data={"offset_ms": "0"}, files={"other": ("x", b"x")}
    )
    assert response.status_code == 400


def test_unknown_channel_layout_is_400(app_module, tmp_path):
    audio = write_audio(tmp_path / "a.json", (0.1, 1))
    response = TestClient(app_module.app).post(
        "/transcribe", json={"file_path": str(audio), "channel_layout": "5.1"}
    )
    assert response.status_code == 400


def test_engine_failure_is_500(app_module, tmp_path):
    bad = tmp_path / "broken.webm"
    bad.write_text("not json", encoding="utf8")
    response = TestClient(app_module.app).post("/transcribe", json={"file_path": str(bad)})
    assert response.status_code == 500
    assert response.json()["detail"].startswith("Transcription failed")


def test_stereo_transcribes_each_channel_and_tags_it(app_module, tmp_path):
    app_module.fake.scripts[0.1] = [
        seg("I will send the deck", 2.0, 4.0),
    ]
    app_module.fake.scripts[0.2] = [
        seg("Can you send the deck", 0.0, 1.5),
        seg("Thanks", 5.0, 5.5),
    ]
    audio = write_audio(tmp_path / "a.json", (0.1, 10), (0.2, 10))

    body = TestClient(app_module.app).post(
        "/transcribe",
        json={"file_path": str(audio), "channel_layout": "stereo-mic-left", "offset_ms": 1000},
    ).json()

    assert [(s["channel"], s["text"], s["startMs"]) for s in body["segments"]] == [
        ("remote", "Can you send the deck", 1000),
        ("mic", "I will send the deck", 3000),
        ("remote", "Thanks", 6000),
    ]
    assert body["channelLayout"] == "stereo-mic-left"
    assert sorted(c["marker"] for c in app_module.fake.calls) == [0.1, 0.2]


def test_stereo_skips_a_silent_channel(app_module, tmp_path):
    app_module.fake.scripts[0.2] = [seg("only remote speaks", 0.0, 2.0)]
    audio = write_audio(tmp_path / "a.json", (0.0, 5), (0.2, 5))

    body = TestClient(app_module.app).post(
        "/transcribe", json={"file_path": str(audio), "channel_layout": "stereo-mic-left"}
    ).json()

    assert [c["marker"] for c in app_module.fake.calls] == [0.2]
    assert [s["channel"] for s in body["segments"]] == ["remote"]


def test_stereo_drops_mic_echo_of_remote_speech(app_module, tmp_path):
    app_module.fake.scripts[0.1] = [seg("the budget is approved", 1.05, 3.0)]
    app_module.fake.scripts[0.2] = [seg("The budget is approved.", 1.0, 3.0)]
    audio = write_audio(tmp_path / "a.json", (0.1, 5), (0.2, 5))

    body = TestClient(app_module.app).post(
        "/transcribe", json={"file_path": str(audio), "channel_layout": "stereo-mic-left"}
    ).json()

    assert [s["channel"] for s in body["segments"]] == ["remote"]


def test_guards_run_inside_the_pipeline(app_module, tmp_path):
    app_module.fake.scripts[0.1] = [
        seg("Thank you for watching.", 0.0, 1.0, no_speech=0.7, logprob=-1.3),
        seg("[Music]", 1.0, 2.0),
        seg("Real words here", 2.0, 3.0),
    ]
    audio = write_audio(tmp_path / "a.json", (0.1, 5))

    body = TestClient(app_module.app).post("/transcribe", json={"file_path": str(audio)}).json()

    assert [s["text"] for s in body["segments"]] == ["Real words here"]


def test_previous_words_remove_boundary_duplicates(app_module, tmp_path):
    app_module.fake.scripts[0.1] = [
        seg("roadmap review then budget", 0.0, 2.0,
            words=[(" roadmap", 0.0, 0.4), (" review", 0.4, 0.8), (" then", 0.9, 1.2), (" budget", 1.2, 2.0)]),
    ]
    audio = write_audio(tmp_path / "a.json", (0.1, 10))

    body = TestClient(app_module.app).post(
        "/transcribe",
        json={
            "file_path": str(audio),
            "offset_ms": 30000,
            "previous_words": [
                {"w": "the", "startMs": 29300, "endMs": 29500},
                {"w": "roadmap", "startMs": 29500, "endMs": 29950},
                {"w": "review,", "startMs": 29950, "endMs": 30000},
            ],
        },
    ).json()

    assert body["segments"][0]["text"] == "then budget"
    assert body["segments"][0]["startMs"] == 30900


def test_previous_words_as_multipart_json_field(app_module, tmp_path):
    app_module.fake.scripts[0.1] = [seg("hello world", 0.0, 1.0)]
    audio = write_audio(tmp_path / "a.json", (0.1, 2))

    with open(audio, "rb") as f:
        body = TestClient(app_module.app).post(
            "/transcribe",
            files={"audio": ("c.webm", f)},
            data={
                "offset_ms": "5000",
                "previous_words": json.dumps([{"w": "Hello", "startMs": 4500, "endMs": 4990}]),
            },
        ).json()

    assert body["segments"][0]["text"] == "world"
