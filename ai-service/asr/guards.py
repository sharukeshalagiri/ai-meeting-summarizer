"""
Hallucination guards applied to every Whisper segment.

Whisper is a language model: over silence, music or noise it happily
writes fluent text ("Thank you for watching."), and on hard audio it
can loop on one phrase. Each guard below targets one of those failure
modes. Thresholds are named so they can be tuned against the
evaluation fixtures instead of being buried in conditions.
"""

from __future__ import annotations

import re
from dataclasses import replace

from .engine import EngineSegment, EngineWord

# --- no speech -------------------------------------------------------
# Whisper's own skip rule: a segment is silence when the model thinks
# there is no speech AND it was unsure of the words it produced. Either
# signal alone throws away too much real, quiet speech.
NO_SPEECH_PROB_THRESHOLD = 0.6
LOW_AVG_LOGPROB_THRESHOLD = -1.0

# --- repetition ------------------------------------------------------
# gzip compression ratio of the text. Natural speech sits around 1.2-1.8;
# above this the text is so repetitive it is almost certainly a loop.
MAX_COMPRESSION_RATIO = 2.4
# A phrase repeated this many times in a row is collapsed to one copy.
REPEAT_COLLAPSE_MIN = 3
# Longest phrase (in words) checked for consecutive repetition.
REPEAT_MAX_PHRASE_WORDS = 8

# --- non-speech ------------------------------------------------------
# Text made only of sound annotations: "[Music]", "(silence)", "♪ ♪",
# "*applause*". Whisper writes these for music and noise.
NON_SPEECH_PATTERN = re.compile(
    r"^(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫#~.…\-]+)\s*)+$"
)
# Stock phrases Whisper invents over silence (learned from subtitled
# video). Dropped only when the model also had doubts about the segment,
# because people do say "thank you" in meetings.
KNOWN_HALLUCINATIONS = (
    "thank you for watching",
    "thanks for watching",
    "please subscribe",
    "like and subscribe",
    "subtitles by",
    "subtitled by",
    "transcribed by",
    "amara.org",
)
HALLUCINATION_PHRASE_NO_SPEECH = 0.3


def _norm(token: str) -> str:
    return re.sub(r"[^\w']", "", token.lower())


def is_no_speech(segment: EngineSegment) -> bool:
    return (
        segment.no_speech_prob > NO_SPEECH_PROB_THRESHOLD
        and segment.avg_logprob < LOW_AVG_LOGPROB_THRESHOLD
    )


def is_repetition_loop(segment: EngineSegment) -> bool:
    return segment.compression_ratio > MAX_COMPRESSION_RATIO


def is_non_speech(segment: EngineSegment) -> bool:
    text = segment.text.strip()

    if not text or NON_SPEECH_PATTERN.match(text):
        return True

    lowered = text.lower()
    return segment.no_speech_prob >= HALLUCINATION_PHRASE_NO_SPEECH and any(
        phrase in lowered for phrase in KNOWN_HALLUCINATIONS
    )


def _collapse_runs(tokens: list[str]) -> list[int]:
    """
    Indices of tokens to keep after collapsing any phrase (1 to
    REPEAT_MAX_PHRASE_WORDS words) repeated REPEAT_COLLAPSE_MIN or more
    times in a row down to its first occurrence.
    """
    keys = [_norm(t) for t in tokens]
    keep = list(range(len(tokens)))
    i = 0
    out: list[int] = []

    while i < len(keys):
        collapsed = False

        for size in range(1, REPEAT_MAX_PHRASE_WORDS + 1):
            phrase = keys[i : i + size]
            if len(phrase) < size or not any(phrase):
                break

            repeats = 1
            while keys[i + repeats * size : i + (repeats + 1) * size] == phrase:
                repeats += 1

            if repeats >= REPEAT_COLLAPSE_MIN:
                out.extend(keep[i : i + size])
                i += repeats * size
                collapsed = True
                break

        if not collapsed:
            out.append(keep[i])
            i += 1

    return out


def collapse_repeats(segment: EngineSegment) -> EngineSegment:
    """Collapses a phrase repeated 3+ times in a row to one copy."""
    if segment.words:
        kept = _collapse_runs([w.word for w in segment.words])
        if len(kept) == len(segment.words):
            return segment
        words: list[EngineWord] = [segment.words[i] for i in kept]
        return replace(
            segment, words=words, text="".join(w.word for w in words).strip()
        )

    tokens = segment.text.split()
    kept = _collapse_runs(tokens)
    if len(kept) == len(tokens):
        return segment
    return replace(segment, text=" ".join(tokens[i] for i in kept))


def apply_guards(segments: list[EngineSegment]) -> list[EngineSegment]:
    """Drops hallucinated segments and de-loops the rest."""
    out: list[EngineSegment] = []

    for segment in segments:
        if is_no_speech(segment) or is_repetition_loop(segment):
            continue

        segment = collapse_repeats(segment)

        if is_non_speech(segment):
            continue

        out.append(segment)

    return out
