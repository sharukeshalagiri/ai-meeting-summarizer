"""App state without any GUI: settings, queue, uploader, current recording.

The tray (tray.py) is a thin view over this, so the start/stop/upload
wiring is testable without pystray or a display.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable

from desk_recorder.api import ApiClient
from desk_recorder.audio import create_source
from desk_recorder.audio.base import AudioSource
from desk_recorder.chunk_queue import ChunkQueue
from desk_recorder.config import Settings, queue_dir
from desk_recorder.recorder import Recorder
from desk_recorder.uploader import Uploader


@dataclass
class Recording:
    local_id: str
    title: str
    started_at: float
    recorder: Recorder


class Controller:
    def __init__(self, settings: Settings | None = None, queue: ChunkQueue | None = None,
                 source_factory: Callable[[Settings], AudioSource] | None = None,
                 notify: Callable[[str, str], None] | None = None) -> None:
        self.settings = settings or Settings.load()
        self.queue = queue or ChunkQueue(queue_dir())
        self.queue.cleanup_partials()
        self.notify = notify or (lambda title, msg: None)
        self.source_factory = source_factory or (
            lambda s: create_source(s.mic_device, s.output_device))
        self.uploader = Uploader(self.queue, self._client(), on_event=self._on_upload_event,
                                 on_session=self._on_session_created)
        self.recording: Recording | None = None
        #: Latest recording, for "Open meeting in web app". The meeting id
        #: is remembered here because the queue folder is deleted once
        #: everything is uploaded.
        self.last_local_id: str | None = None
        self.meeting_ids: dict[str, str] = {}
        self._lock = threading.Lock()

    def _client(self) -> ApiClient:
        return ApiClient(self.settings.api_url, self.settings.device_token)

    def _on_session_created(self, local_id: str, meeting_id: str) -> None:
        if meeting_id:
            self.meeting_ids[local_id] = meeting_id

    def _on_upload_event(self, kind: str, message: str) -> None:
        if kind in ("auth", "failed", "ended"):
            self.notify("Meeting recorder", message)

    # -- lifecycle --

    def start(self) -> None:
        self.uploader.start()

    def shutdown(self) -> None:
        self.stop_recording()
        self.uploader.stop()

    def apply_settings(self, settings: Settings) -> None:
        settings.save()
        self.settings = settings
        self.uploader.set_client(self._client())

    # -- recording --

    @property
    def is_recording(self) -> bool:
        return self.recording is not None

    def start_recording(self, title: str | None = None, platform: str = "OTHER") -> None:
        """Only ever called from a user click (menu item or detection prompt)."""
        with self._lock:
            if self.recording:
                return
            title = title or time.strftime("Desktop recording %Y-%m-%d %H:%M")
            session = self.queue.new_session(title, platform=platform, mode=self.settings.mode,
                                             hints=self.settings.hints)
            source = self.source_factory(self.settings)
            recorder = Recorder(source, self.queue, session.local_id, on_error=self._on_record_error)
            try:
                recorder.start()
            except Exception:
                # Nothing was captured: drop the empty local session.
                self.queue.remove_session(session.local_id)
                raise
            self.recording = Recording(session.local_id, title, time.time(), recorder)
            self.last_local_id = session.local_id

    def _on_record_error(self, exc: Exception) -> None:
        self.notify("Recording stopped", str(exc))
        threading.Thread(target=self.stop_recording, daemon=True).start()

    def stop_recording(self) -> None:
        with self._lock:
            rec = self.recording
            if rec is None:
                return
            self.recording = None
        rec.recorder.stop()  # flushes the final partial chunk
        session = self.queue.get_session(rec.local_id)
        if session is not None:
            session.ended = True
            self.queue.save_session(session)
        self.uploader.wake()

    def elapsed_ms(self) -> int:
        return self.recording.recorder.elapsed_ms if self.recording else 0

    # -- links --

    def meeting_url(self) -> str | None:
        meeting_id = self.meeting_ids.get(self.last_local_id or "")
        if not meeting_id:
            return None
        return f"{self.settings.web_url.rstrip('/')}/meeting/{meeting_id}"
