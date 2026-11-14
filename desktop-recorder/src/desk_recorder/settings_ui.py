"""Settings window and small prompts (tkinter, ships with Python)."""

from __future__ import annotations

import tkinter as tk
from dataclasses import replace
from tkinter import messagebox, simpledialog, ttk
from typing import Callable

from desk_recorder.audio import list_devices
from desk_recorder.config import Settings

DEFAULT_LABEL = "(system default)"


def open_settings(root: tk.Tk, current: Settings, on_save: Callable[[Settings], None]) -> None:
    win = tk.Toplevel(root)
    win.title("Meeting recorder settings")
    win.resizable(False, False)
    win.attributes("-topmost", True)

    devices = list_devices()
    mics = [DEFAULT_LABEL] + [d.name for d in devices if d.is_input]
    outputs = [DEFAULT_LABEL] + [d.name for d in devices if not d.is_input]

    api_url = tk.StringVar(value=current.api_url)
    web_url = tk.StringVar(value=current.web_url)
    token = tk.StringVar(value=current.device_token)
    mic = tk.StringVar(value=current.mic_device or DEFAULT_LABEL)
    output = tk.StringVar(value=current.output_device or DEFAULT_LABEL)
    detect = tk.BooleanVar(value=current.detect_meetings)

    rows: list[tuple[str, tk.Widget]] = [
        ("Backend API URL", ttk.Entry(win, textvariable=api_url, width=44)),
        ("Web app URL", ttk.Entry(win, textvariable=web_url, width=44)),
        ("Device token", ttk.Entry(win, textvariable=token, width=44, show="*")),
        ("Microphone (left)", ttk.Combobox(win, textvariable=mic, values=mics, width=41, state="readonly")),
        ("Output to capture (right)",
         ttk.Combobox(win, textvariable=output, values=outputs, width=41, state="readonly")),
    ]
    for i, (label, widget) in enumerate(rows):
        ttk.Label(win, text=label).grid(row=i, column=0, sticky="w", padx=8, pady=4)
        widget.grid(row=i, column=1, padx=8, pady=4)
    ttk.Checkbutton(win, text="Offer to record when a meeting app uses the mic",
                    variable=detect).grid(row=len(rows), column=0, columnspan=2, sticky="w", padx=8)

    def save() -> None:
        url = api_url.get().strip()
        if not url.startswith(("http://", "https://")):
            messagebox.showerror("Settings", "Backend API URL must start with http:// or https://", parent=win)
            return
        pick = lambda v: "" if v.get() == DEFAULT_LABEL else v.get()  # noqa: E731
        on_save(replace(current, api_url=url, web_url=web_url.get().strip(),
                        device_token=token.get().strip(), mic_device=pick(mic),
                        output_device=pick(output), detect_meetings=detect.get()))
        win.destroy()

    buttons = ttk.Frame(win)
    buttons.grid(row=len(rows) + 1, column=0, columnspan=2, pady=8)
    ttk.Button(buttons, text="Save", command=save).pack(side="left", padx=4)
    ttk.Button(buttons, text="Cancel", command=win.destroy).pack(side="left", padx=4)
    win.focus_force()


def ask_hints(root: tk.Tk, current: list[str]) -> list[str] | None:
    """Comma-separated names / jargon / agenda; None if cancelled."""
    answer = simpledialog.askstring(
        "Hints", "Names, jargon or agenda items, comma-separated (helps transcription):",
        initialvalue=", ".join(current), parent=root)
    if answer is None:
        return None
    return [h.strip()[:500] for h in answer.split(",") if h.strip()][:20]


def ask_yes_no(root: tk.Tk, title: str, message: str) -> bool:
    return bool(messagebox.askyesno(title, message, parent=root))


def show_error(root: tk.Tk, title: str, message: str) -> None:
    messagebox.showerror(title, message, parent=root)
