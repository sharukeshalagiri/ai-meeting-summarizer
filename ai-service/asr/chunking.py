"""
Chunk-boundary handling for live capture.

Recorders cut audio every 10-30 s without looking at the signal, so a
word can straddle the cut. Two things go wrong there: each side may
transcribe a garbled half-word, or both sides may transcribe the same
word. The approach (see docs/decisions/w1-asr.md):

1. Inside a chunk, Silero VAD splits speech at silences (engine.py), so
   Whisper never decodes across a pause.
2. At the edges of a chunk, low-confidence words that touch the cut are
   dropped (`trim_edge_fragments`): a half-word decodes with low
   probability.
3. Across chunks, when the caller passes the previous chunk's tail words,
   repeated edge words are removed from the head of this chunk
   (`dedupe_against_previous`). This needs no overlap in the audio, so
   the capture contract is unchanged.

Segments here are output dicts on the meeting timeline:
{"text", "startMs", "endMs", "words": [{"w", "startMs", "endMs", "p"}], ...}
"""

from __future__ import annotations

import re

# Words this close to a chunk edge may be cut by it.
EDGE_WINDOW_MS = 300
# ...and are dropped when Whisper was this unsure of them.
EDGE_WORD_MIN_PROB = 0.4
# Longest run of words looked for at the start of a chunk that repeats
# the end of the previous chunk.
MAX_BOUNDARY_DEDUP_WORDS = 6
# The repeated words must sit this close to the boundary on the
# timeline; anything further apart is a genuine repetition by the
# speaker ("no, no").
BOUNDARY_DEDUP_WINDOW_MS = 1500


def _norm(word: str) -> str:
    return re.sub(r"[^\w']", "", word.lower())


def _with_words(segment: dict, words: list[dict]) -> dict | None:
    """Rebuilds a segment from a reduced word list (None if empty)."""
    if not words:
        return None
    return {
        **segment,
        "words": words,
        "text": " ".join(w["w"] for w in words).strip(),
        "startMs": words[0]["startMs"],
        "endMs": max(words[-1]["endMs"], words[0]["startMs"]),
    }


def trim_edge_fragments(
    segments: list[dict], chunk_start_ms: int, chunk_end_ms: int
) -> list[dict]:
    """Drops low-confidence words touching either edge of the chunk."""
    out: list[dict] = []

    for segment in segments:
        words = segment.get("words") or []
        if not words:
            out.append(segment)
            continue

        kept = [
            w
            for w in words
            if not (
                w["p"] < EDGE_WORD_MIN_PROB
                and (
                    w["startMs"] - chunk_start_ms < EDGE_WINDOW_MS
                    or chunk_end_ms - w["endMs"] < EDGE_WINDOW_MS
                )
            )
        ]

        if len(kept) == len(words):
            out.append(segment)
            continue

        rebuilt = _with_words(segment, kept)
        if rebuilt:
            out.append(rebuilt)

    return out


def dedupe_against_previous(
    segments: list[dict], previous_words: list[dict] | None
) -> list[dict]:
    """
    Removes words at the start of this chunk that repeat the last words
    of the previous chunk (the longest such run, up to
    MAX_BOUNDARY_DEDUP_WORDS), when both sides sit near the boundary.
    """
    if not previous_words or not segments:
        return segments

    head: list[dict] = []
    for segment in segments:
        head.extend(segment.get("words") or [])
        if len(head) >= MAX_BOUNDARY_DEDUP_WORDS:
            break

    if not head:
        return segments

    tail = previous_words[-MAX_BOUNDARY_DEDUP_WORDS:]
    tail_keys = [_norm(w.get("w", "")) for w in tail]
    head_keys = [_norm(w["w"]) for w in head]

    # How long after the previous chunk's last word this chunk's first
    # word starts. A duplicate straddling the cut starts right there.
    gap = head[0]["startMs"] - int(tail[-1].get("endMs", 0))
    if gap > BOUNDARY_DEDUP_WINDOW_MS:
        return segments

    drop = 0
    for size in range(min(len(tail_keys), len(head_keys)), 0, -1):
        if tail_keys[-size:] == head_keys[:size] and any(head_keys[:size]):
            drop = size
            break

    if drop == 0:
        return segments

    out: list[dict] = []
    remaining = drop
    for segment in segments:
        words = segment.get("words") or []
        if remaining and words:
            cut = min(remaining, len(words))
            remaining -= cut
            rebuilt = _with_words(segment, words[cut:])
            if rebuilt:
                out.append(rebuilt)
            continue
        out.append(segment)

    return out
