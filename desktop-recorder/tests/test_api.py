"""ApiClient request shapes and envelope parsing, with a stub HTTP session."""

from __future__ import annotations

import pytest
import requests

from desk_recorder.api import ApiClient, NetworkError
from desk_recorder.chunk_queue import ChunkQueue
from desk_recorder.uploader import Uploader


class StubResponse:
    def __init__(self, status: int, body):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class StubHttp:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def request(self, method, url, headers=None, timeout=None, **kw):
        self.requests.append({"method": method, "url": url, "headers": headers,
                              "timeout": timeout, **kw})
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def test_create_session_sends_desktop_source_and_token():
    http = StubHttp([StubResponse(201, {"success": True, "message": "",
                                        "data": {"sessionId": "s", "meetingId": "m"}})])
    res = ApiClient("http://x/api/", "tok", http=http).create_session("T", "ZOOM", "AUTO", ["a"])
    req = http.requests[0]
    assert req["url"] == "http://x/api/live/sessions"
    assert req["headers"] == {"Authorization": "Bearer tok"}
    assert req["json"]["source"] == "DESKTOP"
    assert res.ok and res.data["sessionId"] == "s"


def test_upload_chunk_multipart_fields(tmp_path):
    audio = tmp_path / "000003.ogg"
    audio.write_bytes(b"x")
    http = StubHttp([StubResponse(200, {"data": {"duplicate": True}})])
    res = ApiClient("http://x/api", "", http=http).upload_chunk(
        "s", seq=3, start_offset_ms=60000, duration_ms=20000,
        channel_layout="stereo-mic-left", audio=audio, mime_type="audio/ogg")
    req = http.requests[0]
    assert req["headers"] == {}  # no token configured: no header
    assert req["data"] == {"seq": "3", "startOffsetMs": "60000", "durationMs": "20000",
                           "channelLayout": "stereo-mic-left"}
    assert req["files"]["audio"][0] == "000003.ogg" and req["files"]["audio"][2] == "audio/ogg"
    assert res.data["duplicate"] is True


def test_end_returns_immediately_with_summarizing_flag():
    """/end answers at once ({summary: null, summarizing: true}); summary runs in background."""
    body = {"success": True, "message": "Live session ended",
            "data": {"meetingId": "m", "alreadyEnded": False, "summary": None, "summarizing": True}}
    http = StubHttp([StubResponse(200, body)])
    res = ApiClient("http://x/api", "", http=http).end_session("s")
    assert res.ok and res.data["summarizing"] is True and res.data["summary"] is None
    assert http.requests[0]["timeout"] == ApiClient.JSON_TIMEOUT_S


def test_uploader_finishes_session_on_summarizing_end(tmp_path):
    q = ChunkQueue(tmp_path / "q")
    s = q.new_session("t")
    s.session_id, s.ended = "s", True
    q.save_session(s)
    http = StubHttp([StubResponse(200, {"data": {"meetingId": "m", "alreadyEnded": False,
                                                  "summary": None, "summarizing": True}})])
    Uploader(q, ApiClient("http://x/api", "", http=http)).process_once()
    assert q.sessions() == []


def test_network_failure_and_non_json_body():
    http = StubHttp([requests.ConnectionError("refused"), StubResponse(502, None)])
    client = ApiClient("http://x/api", "", http=http)
    with pytest.raises(NetworkError):
        client.end_session("s")
    res = client.end_session("s")
    assert res.status == 502 and res.data is None
