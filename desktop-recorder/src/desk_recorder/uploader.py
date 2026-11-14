"""Drains the ChunkQueue to the backend, following the capture contract.

| Response                 | Action                                          |
| ------------------------ | ----------------------------------------------- |
| 200 (any `duplicate`)    | confirmed: delete the local chunk               |
| 409 still processing     | not a failure: retry the same chunk with backoff|
| 5xx / 429 / network      | retry with backoff (2, 4, 8 ... 30 s)           |
| 401                      | pause every upload until settings change        |
| 410 session ended        | stop: move the session's chunks to failed/      |
| 400 / 404 / 413 / other  | permanent: move the chunk to failed/            |

`process_once()` does one pass and is what the tests drive, with a fake
client and a fake clock; `run()` loops it on a thread.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Protocol

from desk_recorder.api import ApiResponse, NetworkError
from desk_recorder.chunk_queue import ChunkQueue, QueuedChunk, QueuedSession
from desk_recorder.config import backoff_seconds

log = logging.getLogger("desk_recorder.uploader")

RETRYABLE = {408, 409, 425, 429}


def is_retryable(status: int) -> bool:
    return status in RETRYABLE or status >= 500


class Client(Protocol):
    def create_session(self, title: str, platform: str, mode: str,
                       hints: list[str]) -> ApiResponse: ...

    def upload_chunk(self, session_id: str, **kwargs) -> ApiResponse: ...

    def end_session(self, session_id: str) -> ApiResponse: ...


@dataclass
class UploaderStatus:
    pending: int = 0
    auth_error: bool = False
    last_error: str = ""


class Uploader:
    def __init__(self, queue: ChunkQueue, client: Client,
                 clock: Callable[[], float] = time.time,
                 on_event: Callable[[str, str], None] | None = None) -> None:
        self.queue = queue
        self.client = client
        self.clock = clock
        #: on_event(kind, message): "session" (meetingId known), "failed",
        #: "auth", "ended". The tray turns these into notifications.
        self.on_event = on_event or (lambda kind, msg: None)
        self.auth_blocked = False
        self.last_error = ""
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        queue.subscribe(self._wake.set)

    # -- configuration --

    def set_client(self, client: Client) -> None:
        """New URL/token from Settings: clears a 401 pause and retries now."""
        self.client = client
        self.auth_blocked = False
        self.last_error = ""
        self._wake.set()

    def status(self) -> UploaderStatus:
        return UploaderStatus(self.queue.pending_count(), self.auth_blocked, self.last_error)

    # -- one pass --

    def _backoff(self, attempts: int) -> float:
        return self.clock() + backoff_seconds(attempts)

    def _auth_failed(self) -> None:
        self.auth_blocked = True
        self.last_error = "Device token rejected (401). Fix it in Settings."
        self.on_event("auth", self.last_error)

    def _ensure_session(self, s: QueuedSession) -> bool:
        if s.session_id:
            return True
        if s.next_attempt_at > self.clock():
            return False
        try:
            res = self.client.create_session(s.title, s.platform, s.mode, s.hints)
        except NetworkError as exc:
            res = None
            self.last_error = str(exc)
        if res is not None and res.ok and isinstance(res.data, dict) and res.data.get("sessionId"):
            s.session_id = str(res.data["sessionId"])
            s.meeting_id = str(res.data.get("meetingId") or "") or None
            s.attempts, s.next_attempt_at = 0, 0.0
            self.queue.save_session(s)
            self.on_event("session", s.meeting_id or "")
            return True
        if res is not None and res.status == 401:
            self._auth_failed()
            return False
        if res is not None and not is_retryable(res.status):
            self.queue.move_to_failed(s.local_id, None, f"create session: HTTP {res.status} {res.message}")
            self.queue.remove_session(s.local_id)
            self.on_event("failed", f"Backend rejected the recording '{s.title}' ({res.status}).")
            return False
        s.attempts += 1
        s.next_attempt_at = self._backoff(s.attempts)
        if res is not None:
            self.last_error = f"create session: HTTP {res.status}"
        self.queue.save_session(s)
        return False

    def _upload(self, s: QueuedSession, c: QueuedChunk) -> str:
        """Returns "done", "retry", "stop-session" or "stop-all"."""
        assert s.session_id
        try:
            res = self.client.upload_chunk(
                s.session_id, seq=c.seq, start_offset_ms=c.start_offset_ms,
                duration_ms=c.duration_ms, channel_layout=c.channel_layout,
                audio=self.queue.audio_path(s.local_id, c), mime_type=c.mime_type)
        except NetworkError as exc:
            self.last_error = str(exc)
            res = None
        except FileNotFoundError:
            self.queue.remove_chunk(s.local_id, c)
            return "done"
        if res is not None and res.ok:
            self.queue.remove_chunk(s.local_id, c)
            self.last_error = ""
            return "done"
        if res is not None and res.status == 401:
            self._auth_failed()
            return "stop-all"
        if res is not None and res.status == 410:
            self.queue.move_to_failed(s.local_id, None, "session already ended on the backend (410)")
            self.queue.remove_session(s.local_id)
            self.on_event("ended", f"'{s.title}' was ended on the backend; unsent audio kept in failed/.")
            return "stop-session"
        if res is not None and not is_retryable(res.status):
            self.queue.move_to_failed(s.local_id, c, f"HTTP {res.status} {res.message}")
            self.on_event("failed", f"Chunk {c.seq} rejected ({res.status}); kept in failed/.")
            return "done"
        c.attempts += 1
        c.next_attempt_at = self._backoff(c.attempts)
        self.queue.save_chunk(s.local_id, c)
        if res is not None and res.status != 409:
            self.last_error = f"chunk {c.seq}: HTTP {res.status}"
        # 409 means this seq is still being processed; others may be fine.
        return "retry" if res is not None and res.status == 409 else "stop-session"

    def _maybe_end(self, s: QueuedSession) -> None:
        if not (s.ended and s.session_id) or s.next_attempt_at > self.clock():
            return
        if self.queue.chunks(s.local_id):
            return
        try:
            res = self.client.end_session(s.session_id)
        except NetworkError as exc:
            self.last_error = str(exc)
            res = None
        if res is not None and (res.ok or res.status in (404, 410)):
            self.queue.remove_session(s.local_id)
            return
        if res is not None and res.status == 401:
            self._auth_failed()
            return
        s.attempts += 1
        s.next_attempt_at = self._backoff(s.attempts)
        self.queue.save_session(s)

    def process_once(self) -> None:
        if self.auth_blocked:
            return
        for s in self.queue.sessions():
            if not self._ensure_session(s):
                if self.auth_blocked:
                    return
                continue
            outcome = "done"
            for c in self.queue.chunks(s.local_id):
                if c.next_attempt_at > self.clock():
                    continue
                outcome = self._upload(s, c)
                if outcome in ("stop-session", "stop-all"):
                    break
            if outcome == "stop-all":
                return
            if outcome != "stop-session":
                # Re-read: the session file may have been removed above.
                fresh = self.queue.get_session(s.local_id)
                if fresh is not None:
                    self._maybe_end(fresh)

    def next_due_in(self) -> float:
        """Seconds until something can be tried again (for the loop's sleep)."""
        now = self.clock()
        due: list[float] = []
        for s in self.queue.sessions():
            if not s.session_id or (s.ended and not self.queue.chunks(s.local_id)):
                due.append(s.next_attempt_at)
            due.extend(c.next_attempt_at for c in self.queue.chunks(s.local_id))
        if not due:
            return 60.0
        return max(0.0, min(due) - now)

    # -- thread --

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self.run, name="uploader", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def wake(self) -> None:
        self._wake.set()

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                self.process_once()
            except Exception:  # noqa: BLE001 - keep the loop alive; files stay queued
                log.exception("upload pass failed")
            wait = 60.0 if self.auth_blocked else min(max(self.next_due_in(), 0.2), 30.0)
            self._wake.wait(wait)
            self._wake.clear()
