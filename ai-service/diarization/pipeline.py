"""
One /diarize request: decode, pick the remote channel, embed each
requested segment, cluster within the request, and return one centroid
per cluster. The backend matches those centroids to the meeting's
SpeakerProfile rows, which is what keeps labels stable across chunks.
"""

from __future__ import annotations

import numpy as np

from . import cluster, engines, turns

SAMPLE_RATE = engines.SAMPLE_RATE


def decode(path: str, channel_layout: str) -> np.ndarray:
    """
    The audio to diarize: the right channel (everyone else) for
    stereo-mic-left, the whole signal for mono. The left channel is the
    user's mic and is attributed to "me" by the backend without a model.
    """
    from asr import engine as asr_engine

    if channel_layout == "stereo-mic-left":
        _left, right = asr_engine.decode(path, split_stereo=True)
        return np.asarray(right, dtype=np.float32)
    return np.asarray(asr_engine.decode(path, split_stereo=False), dtype=np.float32)


def _local_span(segment: dict, offset_ms: int, total_s: float) -> tuple[float, float]:
    start = max(0.0, (int(segment["startMs"]) - offset_ms) / 1000)
    end = min(total_s, (int(segment["endMs"]) - offset_ms) / 1000)
    return start, max(start, end)


def _round(vector: np.ndarray) -> list[float]:
    return [round(float(x), 5) for x in vector]


def _clusters_from_labels(labels, spans, vectors, members_of):
    result = []
    for number in sorted(set(labels)):
        idx = [i for i, label in enumerate(labels) if label == number]
        weights = [spans[i][1] - spans[i][0] for i in idx]
        centroid = cluster.weighted_centroid([vectors[i] for i in idx], weights)
        result.append(
            {
                "members": [members_of[i] for i in idx],
                "centroid": _round(centroid),
                "speechMs": int(round(sum(weights) * 1000)),
            }
        )
    return result


def _embed_pieces(audio, segments, offset_ms, engine):
    """
    Cuts every segment into speaker-turn pieces (turns.py), then embeds
    each piece. Returns the pieces (meeting-time spans with their
    segment index) and, for the embeddable ones, vectors and spans.
    Every segment gets at least one piece, so none is lost.
    """
    total_s = len(audio) / SAMPLE_RATE

    def embed_span(a: float, b: float):
        return engine.embed(audio[int(a * SAMPLE_RATE) : int(b * SAMPLE_RATE)])

    pieces, vectors, spans, members, skipped = [], [], [], [], []
    for i, segment in enumerate(segments):
        start, end = _local_span(segment, offset_ms, total_s)
        parts_of_segment = turns.split_segment(
            start, end, segment.get("words") or [], offset_ms, embed_span
        ) or [(start, end)]

        for a, b in parts_of_segment:
            index = len(pieces)
            pieces.append(
                {
                    "segment": i,
                    "startMs": int(round(a * 1000)) + offset_ms,
                    "endMs": int(round(b * 1000)) + offset_ms,
                }
            )
            windows = cluster.windows(a, b)
            if not windows:
                skipped.append(index)
                continue
            embedded = [embed_span(x, y) for x, y in windows]
            vectors.append(cluster.weighted_centroid(embedded, [y - x for x, y in windows]))
            spans.append((a, b))
            members.append(index)
    return pieces, vectors, spans, members, skipped


def _pyannote(audio, segments, offset_ms, engine):
    """Maps pyannote's turns onto our segments by largest overlap."""
    total_s = len(audio) / SAMPLE_RATE
    turns, embeddings = engine.diarize_waveform(audio)
    by_label: dict[str, list[int]] = {}
    speech: dict[str, float] = {}
    skipped = []
    for i, segment in enumerate(segments):
        start, end = _local_span(segment, offset_ms, total_s)
        overlap: dict[str, float] = {}
        for t_start, t_end, label in turns:
            shared = min(end, t_end) - max(start, t_start)
            if shared > 0:
                overlap[label] = overlap.get(label, 0.0) + shared
        if not overlap or end - start < cluster.MIN_SEGMENT_S:
            skipped.append(i)
            continue
        label = max(overlap, key=overlap.get)
        by_label.setdefault(label, []).append(i)
        speech[label] = speech.get(label, 0.0) + (end - start)
    clusters = [
        {
            "members": members,
            "centroid": _round(cluster.normalize(embeddings[label]))
            if label in embeddings
            else [],
            "speechMs": int(round(speech[label] * 1000)),
        }
        for label, members in by_label.items()
    ]
    return clusters, skipped


def diarize_file(
    path: str,
    offset_ms: int,
    channel_layout: str,
    segments: list[dict],
    engine=None,
) -> dict:
    """
    `segments` are [{startMs, endMs, words?}] on the meeting timeline
    (the request's offset_ms is where this file starts; words are
    [{startMs, endMs}]). Each segment is cut into speaker-turn `pieces`
    ({segment, startMs, endMs}); clusters' `members` and `skipped`
    (pieces too short to embed) index into `pieces`.
    """
    engine = engine or engines.get_engine()
    audio = decode(path, channel_layout)

    if hasattr(engine, "diarize_waveform"):
        clusters, skipped = _pyannote(audio, segments, offset_ms, engine)
        # pyannote attributes whole segments: one piece per segment.
        pieces = [
            {"segment": i, "startMs": int(s["startMs"]), "endMs": int(s["endMs"])}
            for i, s in enumerate(segments)
        ]
    else:
        pieces, vectors, spans, members, skipped = _embed_pieces(
            audio, segments, offset_ms, engine
        )
        labels = cluster.agglomerate(vectors)
        clusters = _clusters_from_labels(labels, spans, vectors, members)

    return {
        "engine": engine.name,
        "model": engine.model,
        # Cluster members and `skipped` index into `pieces`.
        "pieces": pieces,
        "clusters": clusters,
        "skipped": skipped,
    }
