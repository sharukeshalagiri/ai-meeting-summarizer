"""Durable local upload queue: one folder per recording, one file per chunk.

Layout (under config.queue_dir()):

    <localId>/session.json         title, mode, hints, sessionId once created
    <localId>/000003.ogg           encoded audio
    <localId>/000003.json          seq, offsets, attempts, nextAttemptAt
    ../failed/<localId>/...        chunks the backend rejected for good

A chunk counts as queued only once its .json exists. The audio is written
first and both writes go through a temp file + os.replace, so a crash or
power loss never leaves a half-written chunk that looks complete. Files
are deleted only after the backend confirms the chunk (200), which is what
lets the queue resume after a restart or a network outage.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

SESSION_FILE = "session.json"
#: Empty file meaning "the user pressed Stop". Separate from session.json
#: so no stale in-memory copy can ever un-end a session (see save_session).
ENDED_MARKER = "ended"


def _write_json(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


@dataclass
class QueuedSession:
    local_id: str
    title: str
    platform: str = "OTHER"
    mode: str = "AUTO"
    hints: list[str] = field(default_factory=list)
    session_id: str | None = None
    meeting_id: str | None = None
    #: The user pressed Stop; /end is sent once every chunk is confirmed.
    ended: bool = False
    created_at: float = 0.0
    attempts: int = 0
    next_attempt_at: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "localId": self.local_id, "title": self.title, "platform": self.platform,
            "mode": self.mode, "hints": self.hints, "sessionId": self.session_id,
            "meetingId": self.meeting_id, "ended": self.ended, "createdAt": self.created_at,
            "attempts": self.attempts, "nextAttemptAt": self.next_attempt_at,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "QueuedSession":
        return cls(
            local_id=str(data["localId"]), title=str(data.get("title") or "Desktop recording"),
            platform=str(data.get("platform") or "OTHER"), mode=str(data.get("mode") or "AUTO"),
            hints=list(data.get("hints") or []), session_id=data.get("sessionId"),
            meeting_id=data.get("meetingId"), ended=bool(data.get("ended")),
            created_at=float(data.get("createdAt") or 0), attempts=int(data.get("attempts") or 0),
            next_attempt_at=float(data.get("nextAttemptAt") or 0),
        )


@dataclass
class QueuedChunk:
    seq: int
    start_offset_ms: int
    duration_ms: int
    channel_layout: str
    file: str
    mime_type: str
    attempts: int = 0
    next_attempt_at: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "seq": self.seq, "startOffsetMs": self.start_offset_ms,
            "durationMs": self.duration_ms, "channelLayout": self.channel_layout,
            "file": self.file, "mimeType": self.mime_type, "attempts": self.attempts,
            "nextAttemptAt": self.next_attempt_at,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "QueuedChunk":
        return cls(
            seq=int(data["seq"]), start_offset_ms=int(data["startOffsetMs"]),
            duration_ms=int(data["durationMs"]), channel_layout=str(data["channelLayout"]),
            file=str(data["file"]), mime_type=str(data.get("mimeType") or "application/octet-stream"),
            attempts=int(data.get("attempts") or 0),
            next_attempt_at=float(data.get("nextAttemptAt") or 0),
        )


class ChunkQueue:
    def __init__(self, root: Path, clock: Callable[[], float] = time.time) -> None:
        self.root = Path(root)
        self.failed_root = self.root.parent / "failed"
        self.root.mkdir(parents=True, exist_ok=True)
        self._clock = clock
        self._lock = threading.RLock()
        self._listeners: list[Callable[[], None]] = []

    # -- change notifications (tray counter, uploader wake-up) --

    def subscribe(self, listener: Callable[[], None]) -> None:
        self._listeners.append(listener)

    def _changed(self) -> None:
        for listener in list(self._listeners):
            listener()

    # -- sessions --

    def new_session(self, title: str, platform: str = "OTHER", mode: str = "AUTO",
                    hints: list[str] | None = None) -> QueuedSession:
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(self._clock()))
        session = QueuedSession(local_id=f"{stamp}-{uuid.uuid4().hex[:8]}", title=title,
                                platform=platform, mode=mode, hints=list(hints or []),
                                created_at=self._clock())
        with self._lock:
            (self.root / session.local_id).mkdir(parents=True)
            self.save_session(session)
        self._changed()
        return session

    def _load(self, folder: Path) -> QueuedSession | None:
        data = _read_json(folder / SESSION_FILE)
        if data is None or data.get("localId") != folder.name:
            return None
        session = QueuedSession.from_json(data)
        if (folder / ENDED_MARKER).exists():
            session.ended = True
        return session

    def save_session(self, session: QueuedSession) -> None:
        """Persist `session`, merged with what is on disk.

        The uploader thread and the UI (stop_recording) both hold copies of
        a session and save them back. A plain overwrite loses updates: the
        uploader's stale copy (ended=False) used to overwrite the user's
        Stop, so /end was never sent, and a stale UI copy could clear the
        sessionId and create a duplicate backend session. So, under the
        lock: `ended` only goes False -> True (and also lives in its own
        marker file that only mark_ended() writes), and sessionId and
        meetingId are never cleared once known. Saving a session whose
        folder is already gone (finished or failed meanwhile) is a no-op.
        """
        with self._lock:
            folder = self.root / session.local_id
            if not folder.is_dir():
                return
            current = self._load(folder)
            if current is not None:
                session.ended = session.ended or current.ended
                session.session_id = session.session_id or current.session_id
                session.meeting_id = session.meeting_id or current.meeting_id
            if session.ended:
                (folder / ENDED_MARKER).touch()
            _write_json(folder / SESSION_FILE, session.to_json())

    def mark_ended(self, local_id: str) -> None:
        """The user stopped this recording; /end goes out after the last chunk."""
        with self._lock:
            folder = self.root / local_id
            if not folder.is_dir():
                return
            (folder / ENDED_MARKER).touch()
            current = self._load(folder)
            if current is not None:
                self.save_session(current)
        self._changed()

    def sessions(self) -> list[QueuedSession]:
        """Every queued recording, oldest first."""
        out: list[QueuedSession] = []
        with self._lock:
            for folder in sorted(p for p in self.root.iterdir() if p.is_dir()):
                session = self._load(folder)
                if session is not None:
                    out.append(session)
        out.sort(key=lambda s: (s.created_at, s.local_id))
        return out

    def get_session(self, local_id: str) -> QueuedSession | None:
        with self._lock:
            return self._load(self.root / local_id)

    def remove_session(self, local_id: str) -> None:
        with self._lock:
            shutil.rmtree(self.root / local_id, ignore_errors=True)
        self._changed()

    # -- chunks --

    def chunk_audio_path(self, local_id: str, seq: int, extension: str) -> Path:
        """Temp path the encoder writes to; add_chunk() moves it into place."""
        return self.root / local_id / f"{seq:06d}.part{extension}"

    def add_chunk(self, local_id: str, seq: int, start_offset_ms: int, duration_ms: int,
                  channel_layout: str, written: Path, mime_type: str) -> QueuedChunk:
        folder = self.root / local_id
        final = folder / f"{seq:06d}{written.suffix}"
        chunk = QueuedChunk(seq=seq, start_offset_ms=start_offset_ms, duration_ms=duration_ms,
                            channel_layout=channel_layout, file=final.name, mime_type=mime_type)
        with self._lock:
            os.replace(written, final)
            _write_json(folder / f"{seq:06d}.json", chunk.to_json())
        self._changed()
        return chunk

    def chunks(self, local_id: str) -> list[QueuedChunk]:
        folder = self.root / local_id
        out: list[QueuedChunk] = []
        with self._lock:
            for meta in folder.glob("[0-9]*.json"):
                data = _read_json(meta)
                if data is None:
                    continue
                chunk = QueuedChunk.from_json(data)
                if (folder / chunk.file).exists():
                    out.append(chunk)
        return sorted(out, key=lambda c: c.seq)

    def audio_path(self, local_id: str, chunk: QueuedChunk) -> Path:
        return self.root / local_id / chunk.file

    def save_chunk(self, local_id: str, chunk: QueuedChunk) -> None:
        with self._lock:
            _write_json(self.root / local_id / f"{chunk.seq:06d}.json", chunk.to_json())

    def remove_chunk(self, local_id: str, chunk: QueuedChunk) -> None:
        """Delete a chunk after the backend confirmed it. Metadata first, so
        a crash in between leaves stray audio, never a phantom chunk."""
        folder = self.root / local_id
        with self._lock:
            (folder / f"{chunk.seq:06d}.json").unlink(missing_ok=True)
            (folder / chunk.file).unlink(missing_ok=True)
        self._changed()

    def move_to_failed(self, local_id: str, chunk: QueuedChunk | None, reason: str) -> Path:
        """Keep rejected audio out of the queue but on disk, with the reason.

        Used for 400/404/410 and other permanent rejections: retrying them
        unchanged can never succeed, and deleting the user's audio would be
        worse than leaving it for them to inspect.
        """
        dest = self.failed_root / local_id
        dest.mkdir(parents=True, exist_ok=True)
        src = self.root / local_id
        with self._lock:
            if chunk is None:
                for item in src.iterdir():
                    if item.name != SESSION_FILE:
                        shutil.move(str(item), str(dest / item.name))
                shutil.copy2(src / SESSION_FILE, dest / SESSION_FILE)
            else:
                for name in (chunk.file, f"{chunk.seq:06d}.json"):
                    if (src / name).exists():
                        shutil.move(str(src / name), str(dest / name))
            with open(dest / "reason.txt", "a", encoding="utf-8") as fh:
                label = "session" if chunk is None else f"seq {chunk.seq}"
                fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {label}: {reason}\n")
        self._changed()
        return dest

    def pending_count(self) -> int:
        """Chunks waiting to upload, across every recording."""
        with self._lock:
            return sum(len(self.chunks(s.local_id)) for s in self.sessions())

    def cleanup_partials(self) -> None:
        """Drop half-written encoder output left by a crash (never queued)."""
        with self._lock:
            for part in self.root.glob("*/*.part*"):
                part.unlink(missing_ok=True)
            for tmp in self.root.glob("*/*.tmp"):
                tmp.unlink(missing_ok=True)
