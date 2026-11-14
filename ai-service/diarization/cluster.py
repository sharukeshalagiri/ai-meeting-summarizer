"""
Pure numpy pieces: windowing, embedding averages and agglomerative
clustering. No model and no audio decoding here, so all of it is
unit-tested directly.
"""

from __future__ import annotations

import numpy as np

# Embeddings from very short audio are unreliable; segments shorter than
# this are returned as "skipped" and the backend attributes them by
# continuity instead.
MIN_SEGMENT_S = 0.5
# Long segments are embedded in overlapping windows and averaged: a
# speaker-embedding model is trained on a few seconds of speech, and one
# embedding of a 25 s monologue weights its start and end oddly.
WINDOW_S = 3.0
HOP_S = 1.5
# Average-linkage cosine similarity at which two clusters in one request
# are the same voice. Calibrated in the bench (docs/decisions/w2-spk.md).
MERGE_SIMILARITY = 0.5


def windows(start_s: float, end_s: float) -> list[tuple[float, float]]:
    """Windows covering [start_s, end_s); one window if it is short."""
    length = end_s - start_s
    if length < MIN_SEGMENT_S:
        return []
    if length <= WINDOW_S:
        return [(start_s, end_s)]

    result = []
    at = start_s
    while at + WINDOW_S < end_s:
        result.append((at, at + WINDOW_S))
        at += HOP_S
    # Last window ends exactly at the segment end, so the tail counts.
    result.append((max(start_s, end_s - WINDOW_S), end_s))
    return result


def normalize(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else vector


def weighted_centroid(vectors: list[np.ndarray], weights: list[float]) -> np.ndarray:
    stacked = np.stack([normalize(v) for v in vectors])
    w = np.asarray(weights, dtype=np.float64)
    if w.sum() <= 0:
        w = np.ones_like(w)
    return normalize((stacked * w[:, None]).sum(axis=0) / w.sum())


def agglomerate(
    embeddings: list[np.ndarray], threshold: float = MERGE_SIMILARITY
) -> list[int]:
    """
    Average-linkage agglomerative clustering on cosine similarity.

    Merges the most similar pair of clusters while their average pairwise
    similarity is at least `threshold`. A live chunk has tens of segments
    at most, so the cubic cost is irrelevant and no extra dependency
    (scipy, sklearn) is needed. Returns a cluster number per input,
    numbered by first appearance.
    """
    n = len(embeddings)
    if n == 0:
        return []

    unit = np.stack([normalize(np.asarray(e, dtype=np.float64)) for e in embeddings])
    sim = unit @ unit.T
    clusters: list[list[int]] = [[i] for i in range(n)]

    while len(clusters) > 1:
        best = (-2.0, -1, -1)
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                score = float(sim[np.ix_(clusters[a], clusters[b])].mean())
                if score > best[0]:
                    best = (score, a, b)
        score, a, b = best
        if score < threshold:
            break
        clusters[a] = clusters[a] + clusters[b]
        del clusters[b]

    labels = [0] * n
    for number, members in enumerate(sorted(clusters, key=min)):
        for i in members:
            labels[i] = number
    return labels
