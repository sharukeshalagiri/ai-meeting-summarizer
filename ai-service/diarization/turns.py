"""
Speaker-turn splitting inside one ASR segment.

Whisper (with VAD) can return one segment that spans several speakers:
faster-whisper decodes the VAD speech regions together, so a 1-3 s pause
between two people does not always end a segment. Attributing whole
segments then gives every voice in it one label, and the mixed
embedding sits between voices, so it matches whoever is closest
(found by the lead's synthetic multi-voice test of PR #12).

So each segment is cut into pieces before embedding:

1. Word gaps: consecutive words (from the ASR word timings) more than
   PIECE_GAP_S apart start a new piece. A pause is where a turn change
   almost always is.
2. Voice change: a piece long enough for two windows is scanned with
   non-overlapping CHANGE_WINDOW_S windows; where the voice on either
   side of a word boundary differs (cosine < CHANGE_SIMILARITY), the
   piece is cut there. This catches a turn change with no pause.

Pieces are clustered like segments were; the backend splits the
segment's words and text at the piece boundaries and merges adjacent
pieces that end up with the same speaker again.
"""

from __future__ import annotations

from typing import Callable

import numpy as np

from . import cluster

# A pause this long between two words may be a turn change.
PIECE_GAP_S = 0.4
# Window either side of a candidate cut, for the voice-change test.
CHANGE_WINDOW_S = 1.5
# Below this cosine the two sides are different voices. Calibrated on
# the TTS multi-voice clips and the AMI bench (docs/decisions/w2-spk.md).
CHANGE_SIMILARITY = 0.45


def _words_in(words: list[dict], start: float, end: float, offset_ms: int):
    """Word spans (local seconds) inside [start, end], in time order."""
    spans = []
    for word in words or []:
        try:
            a = (int(word["startMs"]) - offset_ms) / 1000
            b = (int(word["endMs"]) - offset_ms) / 1000
        except (KeyError, TypeError, ValueError):
            continue
        middle = (a + b) / 2
        if start - 0.05 <= middle <= end + 0.05:
            spans.append((max(start, a), min(end, max(a, b))))
    return sorted(spans)


def gap_pieces(
    start: float, end: float, word_spans: list[tuple[float, float]], gap_s: float = PIECE_GAP_S
) -> list[tuple[float, float]]:
    """Splits [start, end] at word gaps > gap_s. No words: one piece."""
    if not word_spans:
        return [(start, end)]
    pieces = []
    piece_start = start
    for (a_start, a_end), (b_start, _b_end) in zip(word_spans, word_spans[1:]):
        if b_start - a_end > gap_s:
            pieces.append((piece_start, a_end))
            piece_start = b_start
    pieces.append((piece_start, end))
    return [(a, b) for a, b in pieces if b > a]


def change_cuts(
    start: float,
    end: float,
    word_spans: list[tuple[float, float]],
    embed_span: Callable[[float, float], np.ndarray],
    window_s: float = CHANGE_WINDOW_S,
    threshold: float = CHANGE_SIMILARITY,
) -> list[float]:
    """
    Cut times inside [start, end] where the voice changes. Candidates are
    word boundaries with a full window on both sides; the lowest-scoring
    candidates below `threshold` win, at least one window apart.
    """
    if end - start < 2 * window_s:
        return []

    boundaries = sorted(
        {round((a_end + b_start) / 2, 3) for (_, a_end), (b_start, _) in zip(word_spans, word_spans[1:])}
    )
    # Without words, test evenly spaced points instead.
    if not boundaries:
        boundaries = list(np.arange(start + window_s, end - window_s + 1e-6, window_s / 2))

    scored = []
    for t in boundaries:
        if t - start < window_s or end - t < window_s:
            continue
        left = embed_span(t - window_s, t)
        right = embed_span(t, t + window_s)
        score = float(np.dot(cluster.normalize(left), cluster.normalize(right)))
        if score < threshold:
            scored.append((score, t))

    cuts: list[float] = []
    for _score, t in sorted(scored):
        if all(abs(t - c) >= window_s for c in cuts):
            cuts.append(t)
    return sorted(cuts)


def split_segment(
    start: float,
    end: float,
    words: list[dict],
    offset_ms: int,
    embed_span: Callable[[float, float], np.ndarray],
) -> list[tuple[float, float]]:
    """Pieces of one segment (local seconds), in time order."""
    spans = _words_in(words, start, end, offset_ms)
    pieces = []
    for a, b in gap_pieces(start, end, spans):
        inner = [w for w in spans if w[0] >= a - 1e-6 and w[1] <= b + 1e-6]
        cuts = change_cuts(a, b, inner, embed_span)
        edges = [a, *cuts, b]
        pieces.extend((x, y) for x, y in zip(edges, edges[1:]) if y > x)
    return pieces
