"""System-tray UI (pystray) over the Controller.

Threads: tkinter owns the main thread (dialogs must run on one thread),
pystray runs detached, and a status thread refreshes the icon and polls
meeting detection. Work for tkinter is handed over through `self.ui()`.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
import tkinter as tk
import webbrowser
from typing import Callable

import pystray
from PIL import Image, ImageDraw

from desk_recorder.config import MODES
from desk_recorder.controller import Controller
from desk_recorder.detect import Detection, MeetingDetector
from desk_recorder.settings_ui import ask_hints, ask_yes_no, open_settings, show_error

log = logging.getLogger("desk_recorder.tray")

IDLE = (107, 114, 128, 255)
RECORDING = (220, 38, 38, 255)
WAITING = (245, 158, 11, 255)
MODE_LABELS = {"AUTO": "Auto", "GENERAL": "General", "LECTURE": "Lecture",
               "INTERVIEW": "Interview", "PROJECT": "Project", "ONE_ON_ONE": "1:1"}


def make_icon(recording: bool, waiting: bool) -> Image.Image:
    """Red dot while recording (the indicator), grey otherwise; an amber
    badge while chunks are waiting to upload."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if recording:
        draw.ellipse((6, 6, 58, 58), fill=RECORDING)
    else:
        draw.ellipse((6, 6, 58, 58), outline=IDLE, width=8)
        draw.ellipse((22, 22, 42, 42), fill=IDLE)
    if waiting:
        draw.ellipse((40, 40, 62, 62), fill=WAITING, outline=(255, 255, 255, 255), width=3)
    return img


def fmt_elapsed(ms: int) -> str:
    s = ms // 1000
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


class TrayApp:
    STATUS_EVERY_S = 1.0
    DETECT_EVERY_S = 5.0

    def __init__(self, controller: Controller, detector: MeetingDetector | None = None) -> None:
        self.c = controller
        self.c.notify = self.notify
        self.detector = detector or MeetingDetector()
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.attributes("-topmost", True)
        self._ui: queue.Queue[Callable[[], None]] = queue.Queue()
        self._stop = threading.Event()
        self._prompt_open = False
        self._last_look: tuple[bool, bool] | None = None
        self.icon = pystray.Icon("meeting-recorder", make_icon(False, False),
                                 "Meeting recorder", menu=self._menu())

    # -- plumbing --

    def ui(self, fn: Callable[[], None]) -> None:
        self._ui.put(fn)

    def _pump(self) -> None:
        while True:
            try:
                fn = self._ui.get_nowait()
            except queue.Empty:
                break
            try:
                fn()
            except Exception:  # noqa: BLE001 - one failed dialog must not kill the UI
                log.exception("ui task failed")
        if not self._stop.is_set():
            self.root.after(100, self._pump)

    def notify(self, title: str, message: str) -> None:
        try:
            self.icon.notify(message, title)
        except Exception:  # noqa: BLE001 - notifications are best effort
            log.info("notify: %s: %s", title, message)

    # -- menu --

    def _pending(self) -> int:
        return self.c.queue.pending_count()

    def _status_text(self) -> str:
        if self.c.is_recording:
            return f"Recording {fmt_elapsed(self.c.elapsed_ms())}"
        if self.c.uploader.auth_blocked:
            return "Upload paused: check device token"
        return "Idle"

    def _menu(self) -> pystray.Menu:
        item = pystray.MenuItem

        def mode_item(mode: str) -> pystray.MenuItem:
            return item(MODE_LABELS[mode], lambda: self._set_mode(mode),
                        checked=lambda _: self.c.settings.mode == mode, radio=True)

        return pystray.Menu(
            item(lambda _: self._status_text(), None, enabled=False),
            item(lambda _: f"{self._pending()} chunks waiting", None, enabled=False,
                 visible=lambda _: self._pending() > 0),
            pystray.Menu.SEPARATOR,
            item("Start recording", lambda: self.ui(self._start), default=True,
                 visible=lambda _: not self.c.is_recording),
            # Stopping joins the recorder thread and encodes the last chunk;
            # do it off the menu thread so the tray stays responsive.
            item("Stop recording",
                 lambda: threading.Thread(target=self.c.stop_recording, daemon=True).start(),
                 visible=lambda _: self.c.is_recording),
            item("Mode", pystray.Menu(*[mode_item(m) for m in MODES])),
            item("Hints...", lambda: self.ui(self._edit_hints)),
            item("Open meeting in web app", self._open_meeting,
                 enabled=lambda _: self.c.meeting_url() is not None),
            item("Settings...", lambda: self.ui(self._settings)),
            pystray.Menu.SEPARATOR,
            item("Quit", self._quit),
        )

    # -- actions (always from a user click) --

    def _start(self, title: str | None = None, platform: str = "OTHER") -> None:
        try:
            self.c.start_recording(title, platform)
        except Exception as exc:  # noqa: BLE001 - shown to the user
            log.exception("start failed")
            show_error(self.root, "Could not start recording", str(exc))
        self._refresh(force=True)

    def _set_mode(self, mode: str) -> None:
        s = self.c.settings
        s.mode = mode
        self.c.apply_settings(s)

    def _edit_hints(self) -> None:
        hints = ask_hints(self.root, self.c.settings.hints)
        if hints is not None:
            s = self.c.settings
            s.hints = hints
            self.c.apply_settings(s)

    def _settings(self) -> None:
        open_settings(self.root, self.c.settings, self.c.apply_settings)

    def _open_meeting(self) -> None:
        url = self.c.meeting_url()
        if url:
            webbrowser.open(url)

    def _prompt_meeting(self, found: Detection) -> None:
        self._prompt_open = True
        try:
            if self.c.is_recording:
                return
            ok = ask_yes_no(self.root, "Meeting detected",
                            f"{found.app} is in a call. Start recording?\n\n"
                            "Left channel = your mic, right channel = everyone else.")
            if ok:
                self._start(f"{found.app} meeting {time.strftime('%Y-%m-%d %H:%M')}", found.platform)
        finally:
            self._prompt_open = False

    def _quit(self) -> None:
        self._stop.set()
        self.c.shutdown()
        self.icon.stop()
        self.ui(self.root.quit)

    # -- status thread --

    def _refresh(self, force: bool = False) -> None:
        pending = self._pending()
        look = (self.c.is_recording, pending > 0)
        if force or look != self._last_look:
            self.icon.icon = make_icon(*look)
            self._last_look = look
        tip = self._status_text() + (f" - {pending} chunks waiting" if pending else "")
        self.icon.title = f"Meeting recorder: {tip}"[:120]
        self.icon.update_menu()

    def _status_loop(self) -> None:
        last_detect = 0.0
        while not self._stop.wait(self.STATUS_EVERY_S):
            try:
                self._refresh()
                now = time.monotonic()
                if (self.c.settings.detect_meetings and not self.c.is_recording
                        and not self._prompt_open and now - last_detect >= self.DETECT_EVERY_S):
                    last_detect = now
                    found = self.detector.poll()
                    if found:
                        self.notify("Meeting detected", f"{found.app}: start recording?")
                        self.ui(lambda f=found: self._prompt_meeting(f))
            except Exception:  # noqa: BLE001
                log.exception("status loop")

    def run(self) -> None:
        self.c.start()
        self.icon.run_detached()
        threading.Thread(target=self._status_loop, name="status", daemon=True).start()
        self.root.after(100, self._pump)
        self.root.mainloop()
