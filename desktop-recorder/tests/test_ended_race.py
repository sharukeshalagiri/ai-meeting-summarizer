"""Regression: Stop must never be lost to a concurrent uploader save.

Bug (lead's e2e test of PR #5): the uploader loaded a session
(ended=False), made a slow or failing create_session / chunk call, then
saved its stale copy, overwriting the ended=True the user's Stop had
saved in between. /end was never sent and the backend session stayed
ACTIVE. These tests interleave Stop with each in-flight request.
"""

from __future__ import annotations

import threading
import time

import pytest

from desk_recorder.api import ApiResponse, NetworkError
from desk_recorder.audio.fake import FakeSource
from desk_recorder.chunk_queue import ChunkQueue
from desk_recorder.config import Settings
from desk_recorder.controller import Controller
from desk_recorder.uploader import Uploader


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


class HookClient:
    """Backend stub that runs `during_*` hooks while a request is 'in flight'."""

    def __init__(self, create=None, chunk=None):
        self.create = list(create or [ApiResponse(201, {"sessionId": "s-1", "meetingId": "m-1"})])
        self.chunk = list(chunk or [ApiResponse(200, {"duplicate": False})])
        self.during_create = None
        self.during_chunk = None
        self.calls: list[tuple] = []

    @staticmethod
    def _next(script):
        item = script.pop(0) if len(script) > 1 else script[0]
        if isinstance(item, Exception):
            raise item
        return item

    def create_session(self, title, platform, mode, hints):
        self.calls.append(("create",))
        if self.during_create:
            hook, self.during_create = self.during_create, None
            hook()
        return self._next(self.create)

    def upload_chunk(self, session_id, **kw):
        self.calls.append(("chunk", kw["seq"]))
        if self.during_chunk:
            hook, self.during_chunk = self.during_chunk, None
            hook()
        return self._next(self.chunk)

    def end_session(self, session_id):
        self.calls.append(("end", session_id))
        return ApiResponse(200, {"meetingId": "m-1", "alreadyEnded": False,
                                 "summary": None, "summarizing": True})


def add_chunks(q, local_id, seqs):
    for seq in seqs:
        tmp = q.chunk_audio_path(local_id, seq, ".ogg")
        tmp.write_bytes(b"synthetic")
        q.add_chunk(local_id, seq, seq * 20_000, 20_000, "stereo-mic-left", tmp, "audio/ogg")


def drain(up, clock, rounds=10):
    for _ in range(rounds):
        up.process_once()
        clock.now += 60


def assert_ended_cleanly(q, client, seqs):
    names = [c[0] for c in client.calls]
    assert names.count("end") == 1, client.calls
    # Every chunk confirmed before /end.
    assert names.index("end") > max(i for i, c in enumerate(client.calls) if c[0] == "chunk")
    assert sorted({c[1] for c in client.calls if c[0] == "chunk"}) == seqs
    assert q.sessions() == []
    assert list(q.root.iterdir()) == []


@pytest.mark.parametrize("create_result", [
    ApiResponse(201, {"sessionId": "s-1", "meetingId": "m-1"}),  # slow but succeeds
    NetworkError("dead port"),                                   # fails, saved with backoff
    ApiResponse(502),
])
def test_stop_during_create_session_is_not_lost(tmp_path, create_result):
    clock = Clock()
    q = ChunkQueue(tmp_path / "q", clock=clock)
    s = q.new_session("t")
    add_chunks(q, s.local_id, [0, 1])
    client = HookClient(create=[create_result, ApiResponse(201, {"sessionId": "s-1", "meetingId": "m-1"})])
    client.during_create = lambda: (add_chunks(q, s.local_id, [2]), q.mark_ended(s.local_id))
    up = Uploader(q, client, clock=clock)
    up.process_once()  # the in-flight create saves its (stale) copy here
    assert q.get_session(s.local_id) is None or q.get_session(s.local_id).ended
    drain(up, clock)
    assert_ended_cleanly(q, client, [0, 1, 2])


@pytest.mark.parametrize("chunk_result", [NetworkError("dead port"), ApiResponse(409), ApiResponse(503)])
def test_stop_during_chunk_upload_is_not_lost(tmp_path, chunk_result):
    clock = Clock()
    q = ChunkQueue(tmp_path / "q", clock=clock)
    s = q.new_session("t")
    add_chunks(q, s.local_id, [0, 1])
    client = HookClient(chunk=[chunk_result, ApiResponse(200, {"duplicate": False})])
    client.during_chunk = lambda: q.mark_ended(s.local_id)
    up = Uploader(q, client, clock=clock)
    drain(up, clock)
    assert_ended_cleanly(q, client, [0, 1])


def test_stale_ui_copy_cannot_clear_session_id_or_unend(tmp_path):
    q = ChunkQueue(tmp_path / "q")
    s = q.new_session("t")
    stale = q.get_session(s.local_id)          # e.g. UI holds an old copy
    fresh = q.get_session(s.local_id)
    fresh.session_id, fresh.meeting_id = "s-1", "m-1"
    q.save_session(fresh)                       # uploader learned the ids
    q.mark_ended(s.local_id)                    # user pressed Stop
    stale.attempts = 3
    q.save_session(stale)                       # stale save afterwards
    merged = q.get_session(s.local_id)
    assert (merged.session_id, merged.meeting_id, merged.ended) == ("s-1", "m-1", True)


def test_ended_survives_a_restart(tmp_path):
    q = ChunkQueue(tmp_path / "q")
    s = q.new_session("t")
    q.mark_ended(s.local_id)
    assert ChunkQueue(tmp_path / "q").get_session(s.local_id).ended


def test_save_after_session_folder_removed_is_a_noop(tmp_path):
    q = ChunkQueue(tmp_path / "q")
    s = q.new_session("t")
    q.remove_session(s.local_id)
    q.save_session(s)  # e.g. uploader finishing a request for a removed session
    assert q.sessions() == [] and list(q.root.iterdir()) == []


class SlowDeadThenAlive:
    """Threaded variant of the lead's e2e: backend unreachable (slow
    failures) while recording; Stop lands mid-request; then it comes back."""

    def __init__(self):
        self.alive = threading.Event()
        self.calls: list[tuple] = []
        self.lock = threading.Lock()

    def _dead(self):
        time.sleep(0.05)
        raise NetworkError("dead port")

    def create_session(self, title, platform, mode, hints):
        if not self.alive.is_set():
            self._dead()
        return ApiResponse(201, {"sessionId": "s-1", "meetingId": "m-1"})

    def upload_chunk(self, session_id, **kw):
        if not self.alive.is_set():
            self._dead()
        with self.lock:
            self.calls.append(("chunk", kw["seq"]))
        return ApiResponse(200, {"duplicate": False})

    def end_session(self, session_id):
        with self.lock:
            self.calls.append(("end", session_id))
        return ApiResponse(200, {"summary": None, "summarizing": True})


def test_threaded_stop_while_offline_then_reconnect(tmp_path, home, monkeypatch):
    # Collapse backoff so the background uploader retries quickly.
    monkeypatch.setattr("desk_recorder.uploader.backoff_seconds", lambda n: 0.02)
    c = Controller(settings=Settings(), queue=ChunkQueue(tmp_path / "q"),
                   source_factory=lambda s: FakeSource(realtime=True))
    client = SlowDeadThenAlive()
    c.uploader.set_client(client)
    c.uploader.start()
    try:
        c.start_recording("offline")
        time.sleep(1.2)
        c.stop_recording()  # lands while the uploader is mid failing request
        local_id = c.last_local_id
        assert c.queue.get_session(local_id).ended
        client.alive.set()
        c.uploader.wake()
        deadline = time.time() + 10
        while c.queue.sessions() and time.time() < deadline:
            time.sleep(0.05)
    finally:
        c.uploader.stop()
    assert c.queue.sessions() == []
    names = [x[0] for x in client.calls]
    assert names[-1] == "end" and names.count("end") == 1 and "chunk" in names
    assert c.meeting_url() and c.meeting_url().endswith("/meeting/m-1")
