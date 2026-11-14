"""Meeting detection: a call app is running AND the microphone is in use.

Detection only ever *offers* to record ("Meeting detected, start
recording?"). Nothing records without the user's click.

Process presence alone is a weak signal (Zoom, Slack and Teams sit in the
background all day), so where the OS tells us who holds the microphone we
require the call app itself to be using it:

- Windows: the privacy "CapabilityAccessManager" registry store lists, per
  app, when it last started/stopped using the mic (LastUsedTimeStop == 0
  means "using it now"). Readable from HKCU without admin rights.
- Linux (untested): `pactl list source-outputs` names the recording apps.
- macOS (untested): no public API, so it falls back to process presence.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Iterable

import psutil


@dataclass(frozen=True)
class AppRule:
    label: str
    platform: str  # capture-contract platform value
    processes: frozenset[str]
    #: Substrings that identify the app in mic-usage records (exe paths,
    #: packaged-app ids like MSTeams_8wekyb3d8bbwe).
    tokens: tuple[str, ...]


MEETING_APPS: tuple[AppRule, ...] = (
    AppRule("Zoom", "ZOOM",
            frozenset({"zoom.exe", "zoom", "zoom.us", "cpthost.exe", "caphost"}), ("zoom", "cpthost")),
    AppRule("Microsoft Teams", "TEAMS",
            frozenset({"ms-teams.exe", "teams.exe", "msteams", "teams", "microsoft teams",
                       "ms-teams"}), ("teams",)),
    AppRule("Slack", "OTHER", frozenset({"slack.exe", "slack"}), ("slack",)),
    AppRule("Discord", "OTHER", frozenset({"discord.exe", "discord"}), ("discord",)),
)


@dataclass(frozen=True)
class Detection:
    app: str
    platform: str
    #: True when the OS confirmed the app holds the mic, not just running.
    mic_confirmed: bool


def detect(process_names: Iterable[str], mic_users: set[str] | None,
           rules: tuple[AppRule, ...] = MEETING_APPS) -> Detection | None:
    """Pure decision. `mic_users` = lowercased identifiers of apps using the
    mic right now, or None when the OS can't tell us."""
    running = {p.lower() for p in process_names}
    for rule in rules:
        if not running & rule.processes:
            continue
        if mic_users is None:
            return Detection(rule.label, rule.platform, mic_confirmed=False)
        if any(token in user for user in mic_users for token in rule.tokens):
            return Detection(rule.label, rule.platform, mic_confirmed=True)
    return None


# --- OS probes ------------------------------------------------------------

CONSENT_KEY = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"


def active_from_consent(entries: Iterable[tuple[str, int, int]]) -> set[str]:
    """(app key, LastUsedTimeStart, LastUsedTimeStop) -> apps using the mic now."""
    return {name.lower() for name, start, stop in entries if start > 0 and stop == 0}


def _windows_consent_entries() -> list[tuple[str, int, int]]:  # pragma: no cover - Windows only
    import winreg

    out: list[tuple[str, int, int]] = []

    def walk(path: str) -> None:
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, path)
        except OSError:
            return
        with key:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(key, i)
                except OSError:
                    break
                i += 1
                sub = f"{path}\\{name}"
                if name == "NonPackaged":
                    walk(sub)
                    continue
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub) as k:
                        start = int(winreg.QueryValueEx(k, "LastUsedTimeStart")[0])
                        stop = int(winreg.QueryValueEx(k, "LastUsedTimeStop")[0])
                except OSError:
                    continue
                out.append((name, start, stop))

    walk(CONSENT_KEY)
    return out


def _linux_mic_users() -> set[str] | None:  # pragma: no cover - untested platform
    try:
        out = subprocess.run(["pactl", "list", "source-outputs"], capture_output=True,
                             text=True, timeout=5, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    users = set()
    for line in out.splitlines():
        line = line.strip()
        if line.startswith(("application.process.binary", "application.name")):
            users.add(line.split("=", 1)[-1].strip().strip('"').lower())
    return users


def mic_users() -> set[str] | None:
    try:
        if sys.platform == "win32":
            return active_from_consent(_windows_consent_entries())
        if sys.platform.startswith("linux"):
            return _linux_mic_users()
    except Exception:  # noqa: BLE001 - detection is best effort
        return None
    return None


def running_processes() -> set[str]:
    names = set()
    for proc in psutil.process_iter(["name"]):
        name = proc.info.get("name")
        if name:
            names.add(name)
    return names


class MeetingDetector:
    """Edge-triggered: reports a meeting once when it starts, then stays
    quiet until it ends, so the user is asked once per call, not every poll."""

    def __init__(self, probe_processes: Callable[[], Iterable[str]] = running_processes,
                 probe_mic: Callable[[], set[str] | None] = mic_users) -> None:
        self.probe_processes = probe_processes
        self.probe_mic = probe_mic
        self._current: str | None = None

    def poll(self) -> Detection | None:
        found = detect(self.probe_processes(), self.probe_mic())
        if found is None:
            self._current = None
            return None
        if found.app == self._current:
            return None
        self._current = found.app
        return found
