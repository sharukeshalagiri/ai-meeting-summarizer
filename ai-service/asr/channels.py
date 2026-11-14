"""
Stereo channel handling for the capture contract's "stereo-mic-left"
layout: left = the user's microphone, right = everyone else.

Each channel is transcribed on its own and tagged "mic" or "remote",
which gives speaker separation between "me" and "them" for free and
stops Whisper from decoding two people talking over each other as one
garbled stream.
"""

from __future__ import annotations

import difflib
import re

import numpy as np

MIC = "mic"
REMOTE = "remote"

# A channel quieter than this (RMS of float samples in [-1, 1], about
# -60 dBFS) is treated as silent and not transcribed at all: a muted mic
# would otherwise only give Whisper a chance to hallucinate.
SILENT_CHANNEL_RMS = 0.001

# Without headphones the remote audio leaks into the mic. A mic segment
# that overlaps a remote one in time and says nearly the same thing is
# that echo, and is dropped (the remote channel is the clean source).
ECHO_TEXT_SIMILARITY = 0.8
ECHO_MIN_OVERLAP = 0.5


def is_silent(audio) -> bool:
    samples = np.asarray(audio, dtype=np.float32)
    if samples.size == 0:
        return True
    return float(np.sqrt(np.mean(np.square(samples)))) < SILENT_CHANNEL_RMS


def _norm_text(text: str) -> str:
    return " ".join(re.sub(r"[^\w' ]", " ", text.lower()).split())


def _overlap_ratio(a: dict, b: dict) -> float:
    span = a["endMs"] - a["startMs"]
    if span <= 0:
        return 0.0
    shared = min(a["endMs"], b["endMs"]) - max(a["startMs"], b["startMs"])
    return max(0, shared) / span


def drop_echo(mic: list[dict], remote: list[dict]) -> list[dict]:
    """Mic segments minus those that echo an overlapping remote segment."""
    if not remote:
        return mic

    kept = []
    for segment in mic:
        text = _norm_text(segment["text"])
        is_echo = any(
            _overlap_ratio(segment, other) >= ECHO_MIN_OVERLAP
            and difflib.SequenceMatcher(None, text, _norm_text(other["text"])).ratio()
            >= ECHO_TEXT_SIMILARITY
            for other in remote
        )
        if not is_echo:
            kept.append(segment)
    return kept


def merge_by_time(*channels: list[dict]) -> list[dict]:
    """One timeline ordered by start time; mic first on a tie."""
    order = {MIC: 0, REMOTE: 1, None: 2}
    merged = [segment for channel in channels for segment in channel]
    return sorted(
        merged, key=lambda s: (s["startMs"], order.get(s.get("channel"), 2))
    )
