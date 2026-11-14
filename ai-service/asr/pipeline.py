"""
One request, end to end: decode, split channels, transcribe with VAD
and word timestamps, apply the hallucination guards, handle chunk
edges, and shape the response the backend parses
(backend/src/providers/transcription/local.provider.ts).
"""

from __future__ import annotations

from . import engine
from .channels import MIC, REMOTE, drop_echo, is_silent, merge_by_time
from .chunking import dedupe_against_previous, trim_edge_fragments
from .guards import apply_guards
from .hints import build_initial_prompt

CHANNEL_LAYOUTS = ("mono", "stereo-mic-left")


def _to_output(segment: engine.EngineSegment, offset_ms: int, channel: str | None) -> dict:
    words = [
        {
            "w": w.word.strip(),
            "startMs": int(w.start * 1000) + offset_ms,
            "endMs": int(w.end * 1000) + offset_ms,
            "p": round(w.probability, 3),
        }
        for w in segment.words
        if w.word.strip()
    ]
    return {
        "text": segment.text,
        "startMs": int(segment.start * 1000) + offset_ms,
        "endMs": int(segment.end * 1000) + offset_ms,
        # Kept for the backend's own last-line filter; guards already ran.
        "noSpeechProb": round(segment.no_speech_prob, 4),
        "channel": channel,
        "words": words,
    }


def _transcribe_channel(audio, channel, offset_ms, language, prompt):
    if is_silent(audio):
        return [], None
    result = engine.transcribe_waveform(audio, language=language, initial_prompt=prompt)
    segments = [_to_output(s, offset_ms, channel) for s in apply_guards(result.segments)]
    return segments, result.language


def transcribe_file(
    path: str,
    offset_ms: int = 0,
    channel_layout: str = "mono",
    hints: list[str] | None = None,
    language: str | None = None,
    previous_words: list[dict] | None = None,
) -> dict:
    """
    Transcribes one file. `previous_words` is the tail of the previous
    chunk on the timeline (optional), used to remove words repeated
    across the chunk boundary; each may carry "channel" for stereo.
    """
    prompt = build_initial_prompt(hints)
    stereo = channel_layout == "stereo-mic-left"

    if stereo:
        left, right = engine.decode(path, split_stereo=True)
        sources = [(MIC, left), (REMOTE, right)]
        duration_ms = int(len(left) * 1000 / engine.SAMPLE_RATE)
    else:
        audio = engine.decode(path, split_stereo=False)
        sources = [(None, audio)]
        duration_ms = int(len(audio) * 1000 / engine.SAMPLE_RATE)

    per_channel: dict[str | None, list[dict]] = {}
    detected = None

    for channel, audio in sources:
        segments, lang = _transcribe_channel(audio, channel, offset_ms, language, prompt)
        segments = trim_edge_fragments(segments, offset_ms, offset_ms + duration_ms)
        previous = [
            w
            for w in (previous_words or [])
            if w.get("channel") in (channel, None)
        ]
        per_channel[channel] = dedupe_against_previous(segments, previous)
        # Prefer the language detected on the remote side: the meeting's
        # language, even when the user is muted.
        if lang and (detected is None or channel == REMOTE):
            detected = lang

    if stereo:
        per_channel[MIC] = drop_echo(per_channel[MIC], per_channel[REMOTE])

    segments = merge_by_time(*per_channel.values())

    return {
        "text": " ".join(s["text"] for s in segments).strip(),
        "segments": segments,
        "durationMs": duration_ms,
        "language": language or detected,
        "channelLayout": channel_layout if stereo else "mono",
        "model": engine.MODEL_NAME,
    }
