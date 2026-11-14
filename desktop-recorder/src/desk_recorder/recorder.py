"""Turns an AudioSource into numbered, encoded chunks in the queue.

Offsets come from the number of samples recorded, not from wall-clock or
upload time (contract checklist): chunk `seq` starts at
seq * CHUNK_MS exactly, so the transcript timeline matches the audio even
when uploads lag minutes behind.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

import numpy as np

from desk_recorder.audio.base import AudioSource, AudioSourceError
from desk_recorder.chunk_queue import ChunkQueue
from desk_recorder.config import CHANNEL_LAYOUT, CHUNK_MS, MIN_FINAL_CHUNK_MS
from desk_recorder.encoder import Encoder, get_encoder

log = logging.getLogger("desk_recorder.recorder")


class Recorder:
    READ_S = 0.25
    MAX_EMPTY_READS = 10

    def __init__(self, source: AudioSource, queue: ChunkQueue, local_id: str,
                 encoder: Encoder | None = None, chunk_ms: int = CHUNK_MS,
                 on_error: Callable[[Exception], None] | None = None) -> None:
        self.source = source
        self.queue = queue
        self.local_id = local_id
        self.encoder = encoder or get_encoder()
        self.rate = source.sample_rate
        self.chunk_frames = int(self.rate * chunk_ms / 1000)
        self.on_error = on_error or (lambda exc: None)
        self.seq = 0
        self.frames_written = 0
        self._buffer: list[np.ndarray] = []
        self._buffered = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def elapsed_ms(self) -> int:
        return int((self.frames_written + self._buffered) * 1000 / self.rate)

    def feed(self, frames: np.ndarray) -> None:
        """Add stereo frames; emits a chunk each time chunk_frames are buffered."""
        self._buffer.append(frames)
        self._buffered += len(frames)
        while self._buffered >= self.chunk_frames:
            data = np.concatenate(self._buffer)
            self._emit(data[: self.chunk_frames])
            rest = data[self.chunk_frames:]
            self._buffer = [rest] if len(rest) else []
            self._buffered = len(rest)

    def flush(self) -> None:
        """Emit the final partial chunk (unless it is too short to matter)."""
        if self._buffered * 1000 / self.rate >= MIN_FINAL_CHUNK_MS:
            self._emit(np.concatenate(self._buffer))
        self._buffer, self._buffered = [], 0

    def _emit(self, frames: np.ndarray) -> None:
        start_ms = int(round(self.frames_written * 1000 / self.rate))
        end_ms = int(round((self.frames_written + len(frames)) * 1000 / self.rate))
        tmp = self.queue.chunk_audio_path(self.local_id, self.seq, self.encoder.extension)
        self.encoder.encode(frames, self.rate, tmp)
        self.queue.add_chunk(self.local_id, self.seq, start_ms, end_ms - start_ms,
                             CHANNEL_LAYOUT, tmp, self.encoder.mime_type)
        self.seq += 1
        self.frames_written += len(frames)

    # -- thread --

    def start(self) -> None:
        self.source.start()
        self._thread = threading.Thread(target=self._run, name="recorder", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        block = int(self.rate * self.READ_S)
        silent_reads = 0
        try:
            while not self._stop.is_set():
                frames = self.source.read(block, timeout=1.0)
                if len(frames):
                    silent_reads = 0
                    self.feed(frames)
                    continue
                # The mic drives the clock, so no frames at all (not just
                # silence) means the device vanished, e.g. a headset unplugged.
                silent_reads += 1
                if silent_reads >= self.MAX_EMPTY_READS and not self._stop.is_set():
                    raise AudioSourceError("No audio from the microphone for 10 s. Check the device.")
        except Exception as exc:  # noqa: BLE001 - report, keep what was recorded
            log.exception("recording failed")
            self.on_error(exc)
        finally:
            try:
                self.flush()
            except Exception:  # noqa: BLE001
                log.exception("final chunk failed")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)
        self.source.stop()
