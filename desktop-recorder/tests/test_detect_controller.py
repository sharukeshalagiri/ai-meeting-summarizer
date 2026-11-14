"""Meeting detection rules and the GUI-free controller."""

from __future__ import annotations

import time

import pytest

from desk_recorder.api import ApiResponse
from desk_recorder.audio.fake import FakeSource
from desk_recorder.chunk_queue import ChunkQueue
from desk_recorder.config import Settings
from desk_recorder.controller import Controller
from desk_recorder.detect import MeetingDetector, active_from_consent, detect

# --- detection ---


def test_zoom_with_mic_in_use_is_detected():
    found = detect({"Zoom.exe", "explorer.exe"},
                   {"c:#program files#zoom#bin#zoom.exe"})
    assert found is not None and found.app == "Zoom" and found.platform == "ZOOM"
    assert found.mic_confirmed


def test_app_running_but_mic_idle_is_not_a_meeting():
    assert detect({"Zoom.exe", "slack.exe"}, set()) is None


def test_mic_used_by_another_app_does_not_count():
    assert detect({"Zoom.exe"}, {"c:#windows#system32#soundrecorder.exe"}) is None


@pytest.mark.parametrize("process,mic_user,app,platform", [
    ("ms-teams.exe", "msteams_8wekyb3d8bbwe", "Microsoft Teams", "TEAMS"),
    ("Slack.exe", "c:#users#me#appdata#local#slack#app-4.41#slack.exe", "Slack", "OTHER"),
    ("Discord.exe", "c:#users#me#appdata#local#discord#discord.exe", "Discord", "OTHER"),
])
def test_other_call_apps(process, mic_user, app, platform):
    found = detect({process}, {mic_user})
    assert found is not None and (found.app, found.platform) == (app, platform)


def test_unknown_mic_state_falls_back_to_process_presence():
    found = detect({"zoom.us"}, None)
    assert found is not None and not found.mic_confirmed


def test_consent_store_parsing():
    entries = [("C:#Zoom#Zoom.exe", 133_000, 0),        # in use now
               ("C:#Slack#slack.exe", 133_000, 133_500),  # used earlier, stopped
               ("NeverUsed", 0, 0)]
    assert active_from_consent(entries) == {"c:#zoom#zoom.exe"}


def test_detector_asks_once_per_meeting():
    mic = {"value": {"c:#zoom#zoom.exe"}}
    d = MeetingDetector(probe_processes=lambda: {"Zoom.exe"}, probe_mic=lambda: mic["value"])
    assert d.poll() is not None
    assert d.poll() is None  # same call: no repeated prompt
    mic["value"] = set()
    assert d.poll() is None  # call over
    mic["value"] = {"c:#zoom#zoom.exe"}
    assert d.poll() is not None  # next call prompts again


# --- controller ---


class StubClient:
    def __init__(self):
        self.chunks = []

    def create_session(self, title, platform, mode, hints):
        return ApiResponse(201, {"sessionId": "s-1", "meetingId": "m-42"})

    def upload_chunk(self, session_id, **kw):
        self.chunks.append(kw["seq"])
        return ApiResponse(200, {"duplicate": False})

    def end_session(self, session_id):
        return ApiResponse(200, {})


def test_controller_records_uploads_and_links_the_meeting(tmp_path, home):
    settings = Settings(mode="INTERVIEW", hints=["Priya"], web_url="http://localhost:5121/")
    c = Controller(settings=settings, queue=ChunkQueue(tmp_path / "q"),
                   source_factory=lambda s: FakeSource(realtime=True))
    client = StubClient()
    c.uploader.set_client(client)
    assert not c.is_recording
    c.start_recording("Interview", platform="ZOOM")
    assert c.is_recording
    deadline = time.time() + 5
    while c.elapsed_ms() < 1_500 and time.time() < deadline:
        time.sleep(0.05)
    c.stop_recording()
    assert not c.is_recording
    session = c.queue.sessions()[0]
    assert session.ended and session.mode == "INTERVIEW" and session.hints == ["Priya"]
    assert c.queue.pending_count() == 1  # one short final chunk
    c.uploader.process_once()
    assert client.chunks == [0]
    assert c.queue.sessions() == []
    assert c.meeting_url() == "http://localhost:5121/meeting/m-42"


def test_failed_device_start_leaves_no_empty_session(tmp_path, home):
    class Broken(FakeSource):
        def start(self):
            raise RuntimeError("no mic")

    c = Controller(settings=Settings(), queue=ChunkQueue(tmp_path / "q"),
                   source_factory=lambda s: Broken())
    with pytest.raises(RuntimeError):
        c.start_recording()
    assert c.queue.sessions() == [] and not c.is_recording
