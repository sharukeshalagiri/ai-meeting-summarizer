"""Queue durability and the contract's retry rules, with a fake backend + clock."""

from __future__ import annotations

from pathlib import Path

import pytest

from desk_recorder.api import ApiResponse, NetworkError
from desk_recorder.chunk_queue import ChunkQueue
from desk_recorder.config import backoff_seconds
from desk_recorder.uploader import Uploader


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


class FakeClient:
    """Scripted backend. `chunk_script[seq]` is a list of responses (or
    NetworkError) returned in order; the last one repeats."""

    def __init__(self) -> None:
        self.create_script: list = [ApiResponse(201, {"sessionId": "s-1", "meetingId": "m-1"})]
        self.chunk_script: dict[int, list] = {}
        self.end_script: list = [ApiResponse(200, {"alreadyEnded": False})]
        self.calls: list[tuple] = []

    @staticmethod
    def _next(script: list):
        item = script.pop(0) if len(script) > 1 else script[0]
        if isinstance(item, Exception):
            raise item
        return item

    def create_session(self, title, platform, mode, hints):
        self.calls.append(("create", title, platform, mode, tuple(hints)))
        return self._next(self.create_script)

    def upload_chunk(self, session_id, **kw):
        assert Path(kw["audio"]).exists()
        self.calls.append(("chunk", session_id, kw["seq"], kw["start_offset_ms"],
                           kw["duration_ms"], kw["channel_layout"]))
        return self._next(self.chunk_script.get(kw["seq"], [ApiResponse(200, {"duplicate": False})]))

    def end_session(self, session_id):
        self.calls.append(("end", session_id))
        return self._next(self.end_script)

    def chunk_calls(self) -> list[int]:
        return [c[2] for c in self.calls if c[0] == "chunk"]


def add_chunks(q: ChunkQueue, local_id: str, seqs) -> None:
    for seq in seqs:
        tmp = q.chunk_audio_path(local_id, seq, ".ogg")
        tmp.write_bytes(b"synthetic-not-audio")
        q.add_chunk(local_id, seq, seq * 20_000, 20_000, "stereo-mic-left", tmp, "audio/ogg")


@pytest.fixture
def setup(tmp_path):
    clock = Clock()
    q = ChunkQueue(tmp_path / "queue", clock=clock)
    client = FakeClient()
    events: list[tuple[str, str]] = []
    up = Uploader(q, client, clock=clock, on_event=lambda k, m: events.append((k, m)))
    s = q.new_session("Weekly sync", platform="ZOOM", mode="PROJECT", hints=["Priya"])
    return q, client, up, clock, s, events


def test_backoff_doubles_from_2s_and_caps_at_30s():
    assert [backoff_seconds(n) for n in range(1, 8)] == [2, 4, 8, 16, 30, 30, 30]


def test_happy_path_uploads_in_seq_order_deletes_then_ends(setup):
    q, client, up, clock, s, _ = setup
    add_chunks(q, s.local_id, [0, 1, 2])
    assert q.pending_count() == 3
    up.process_once()
    assert client.calls[0] == ("create", "Weekly sync", "ZOOM", "PROJECT", ("Priya",))
    assert client.chunk_calls() == [0, 1, 2]
    assert ("chunk", "s-1", 1, 20_000, 20_000, "stereo-mic-left") in client.calls
    assert q.pending_count() == 0
    assert not any(c[0] == "end" for c in client.calls)  # still recording
    s = q.get_session(s.local_id)
    s.ended = True
    q.save_session(s)
    up.process_once()
    assert client.calls[-1] == ("end", "s-1")
    assert q.sessions() == []


def test_duplicate_true_counts_as_done(setup):
    q, client, up, _, s, _ = setup
    add_chunks(q, s.local_id, [0])
    client.chunk_script[0] = [ApiResponse(200, {"duplicate": True})]
    up.process_once()
    assert q.pending_count() == 0


def test_409_is_retried_with_backoff_and_never_dropped(setup):
    q, client, up, clock, s, events = setup
    add_chunks(q, s.local_id, [0, 1])
    client.chunk_script[0] = [ApiResponse(409), ApiResponse(409), ApiResponse(200, {"duplicate": True})]
    up.process_once()
    # 409 on seq 0 does not block seq 1.
    assert client.chunk_calls() == [0, 1]
    assert [c.seq for c in q.chunks(s.local_id)] == [0]
    up.process_once()  # not due yet (2 s backoff)
    assert client.chunk_calls() == [0, 1]
    clock.now += 2
    up.process_once()
    assert client.chunk_calls() == [0, 1, 0]
    clock.now += 3.9
    up.process_once()  # second backoff is 4 s
    assert client.chunk_calls() == [0, 1, 0]
    clock.now += 0.1
    up.process_once()
    assert q.pending_count() == 0
    assert up.last_error == ""
    assert not [e for e in events if e[0] == "failed"]


@pytest.mark.parametrize("failure", [NetworkError("down"), ApiResponse(502), ApiResponse(503), ApiResponse(429)])
def test_transient_failures_back_off_and_keep_the_chunk(setup, failure):
    q, client, up, clock, s, _ = setup
    add_chunks(q, s.local_id, [0, 1])
    client.chunk_script[0] = [failure, ApiResponse(200, {})]
    up.process_once()
    # The session pauses after a transient failure instead of hammering.
    assert client.chunk_calls() == [0]
    assert q.chunks(s.local_id)[0].attempts == 1
    assert up.last_error
    clock.now += backoff_seconds(1)
    up.process_once()
    assert q.pending_count() == 0


def test_backend_down_at_start_creates_session_later(setup):
    q, client, up, clock, s, _ = setup
    add_chunks(q, s.local_id, [0])
    client.create_script = [NetworkError("refused"), ApiResponse(201, {"sessionId": "s-9", "meetingId": "m-9"})]
    up.process_once()
    assert q.get_session(s.local_id).session_id is None
    assert q.pending_count() == 1
    clock.now += 2
    up.process_once()
    assert q.get_session(s.local_id) is not None or q.pending_count() == 0
    assert ("chunk", "s-9", 0, 0, 20_000, "stereo-mic-left") in client.calls


def test_401_pauses_everything_until_settings_change(setup):
    q, client, up, clock, s, events = setup
    add_chunks(q, s.local_id, [0, 1])
    client.chunk_script[0] = [ApiResponse(401)]
    up.process_once()
    assert up.auth_blocked and events[-1][0] == "auth"
    clock.now += 1000
    up.process_once()
    assert client.chunk_calls() == [0]  # nothing sent while blocked
    assert q.pending_count() == 2  # nothing lost
    fixed = FakeClient()
    up.set_client(fixed)
    up.process_once()
    assert q.pending_count() == 0


def test_410_stops_the_session_and_keeps_audio_in_failed(setup, tmp_path):
    q, client, up, _, s, events = setup
    add_chunks(q, s.local_id, [0, 1, 2])
    client.chunk_script[0] = [ApiResponse(410)]
    up.process_once()
    assert client.chunk_calls() == [0]
    assert q.sessions() == []
    failed = tmp_path / "failed" / s.local_id
    assert sorted(p.name for p in failed.glob("*.ogg")) == ["000000.ogg", "000001.ogg", "000002.ogg"]
    assert "410" in (failed / "reason.txt").read_text()
    assert events[-1][0] == "ended"


def test_400_moves_only_that_chunk_to_failed(setup, tmp_path):
    q, client, up, _, s, _ = setup
    add_chunks(q, s.local_id, [0, 1])
    client.chunk_script[0] = [ApiResponse(400, message="seq is required")]
    up.process_once()
    assert client.chunk_calls() == [0, 1]
    assert q.pending_count() == 0
    assert (tmp_path / "failed" / s.local_id / "000000.ogg").exists()


def test_end_waits_for_every_chunk_and_retries(setup):
    q, client, up, clock, s, _ = setup
    add_chunks(q, s.local_id, [0])
    client.chunk_script[0] = [ApiResponse(502), ApiResponse(200, {})]
    client.end_script = [ApiResponse(502), ApiResponse(200, {"alreadyEnded": True})]
    s = q.get_session(s.local_id)
    s.ended = True
    q.save_session(s)
    up.process_once()
    assert not any(c[0] == "end" for c in client.calls)
    clock.now += 2
    up.process_once()  # chunk ok, end -> 502
    assert client.calls[-1] == ("end", "s-1")
    assert q.sessions()
    clock.now += 2
    up.process_once()
    assert q.sessions() == []


def test_queue_resumes_after_restart(tmp_path):
    clock = Clock()
    q1 = ChunkQueue(tmp_path / "queue", clock=clock)
    s = q1.new_session("Crash test")
    add_chunks(q1, s.local_id, [0, 1])
    # A crash mid-encode leaves a .part file; it must not be uploaded.
    q1.chunk_audio_path(s.local_id, 2, ".ogg").write_bytes(b"half")
    del q1

    q2 = ChunkQueue(tmp_path / "queue", clock=clock)
    q2.cleanup_partials()
    assert q2.pending_count() == 2
    client = FakeClient()
    Uploader(q2, client, clock=clock).process_once()
    assert client.chunk_calls() == [0, 1]
    assert q2.pending_count() == 0


def test_chunk_without_metadata_is_not_queued(tmp_path):
    q = ChunkQueue(tmp_path / "queue")
    s = q.new_session("x")
    (q.root / s.local_id / "000000.ogg").write_bytes(b"orphan")
    assert q.pending_count() == 0


def test_listeners_fire_on_changes(tmp_path):
    q = ChunkQueue(tmp_path / "queue")
    hits = []
    q.subscribe(lambda: hits.append(1))
    s = q.new_session("x")
    add_chunks(q, s.local_id, [0])
    assert len(hits) == 2


def test_next_due_in_reflects_backoff(setup):
    q, client, up, clock, s, _ = setup
    add_chunks(q, s.local_id, [0])
    client.chunk_script[0] = [ApiResponse(409)]
    up.process_once()
    assert up.next_due_in() == pytest.approx(2.0)
