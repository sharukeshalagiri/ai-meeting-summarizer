"""
Speaker bench: RAM, speed and cross-chunk label stability of the default
engine (sherpa-onnx + WeSpeaker ResNet34-LM) on real meeting audio.

    python -m diarization.bench --fetch --minutes 10
    python -m diarization.bench --audio X.wav --rttm X.rttm --minutes 10

Data: AMI meeting ES2004a (Mix-Headset, CC BY 4.0) and its reference
RTTM from pyannote/AMI-diarization-setup. Downloaded into
recordings/benchmark/ami/ (gitignored), never committed.

What it does, with ONE model loaded:
1. Uses the reference speaker turns as the "ASR segments" (oracle
   segmentation, so the number isolates speaker attribution from ASR).
2. Cuts the audio into chunks (default 30 s, like live capture), embeds
   and clusters each chunk exactly as POST /diarize does.
3. Matches clusters across chunks with a Python port of
   backend/src/services/speakers/matcher.ts (same constants; keep in sync).
4. Reports: RSS before/after loading (psutil if installed), embedding
   real-time factor, segment-time speaker error (best one-to-one mapping
   of predicted to reference speakers; a DER-like number on oracle
   segments without overlap or missed-speech terms, so not comparable to
   published DER), the chunk-boundary split rate, and a threshold sweep.

Not a CI test: it needs the model and the data. See docs/decisions/w2-spk.md.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sys
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np

from . import cluster, engines

SR = engines.SAMPLE_RATE

AMI_AUDIO_URL = (
    "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/"
    "{meeting}/audio/{meeting}.Mix-Headset.wav"
)
AMI_RTTM_URL = (
    "https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/main/"
    "only_words/rttms/test/{meeting}.rttm"
)

# Port of matcher.ts (keep in sync).
MATCH_SIMILARITY = 0.55
UPDATE_MARGIN = 0.05
SHORT_CLUSTER_MS = 1000
SHORT_MATCH_SIMILARITY = 0.4
CONTINUITY_MS = 1500


def rss_mb() -> float | None:
    try:
        import psutil
    except ImportError:
        return None
    return psutil.Process().memory_info().rss / 2**20


def parse_rttm(text: str) -> list[tuple[float, float, str]]:
    """SPEAKER lines -> [(start_s, end_s, speaker)] sorted by start."""
    turns = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 8 and parts[0] == "SPEAKER":
            start, duration = float(parts[3]), float(parts[4])
            turns.append((start, start + duration, parts[7]))
    return sorted(turns)


def merge_turns(turns, gap_s: float = 0.5):
    """Joins a speaker's consecutive turns separated by < gap_s."""
    merged: list[list] = []
    for start, end, spk in turns:
        if merged and merged[-1][2] == spk and start - merged[-1][1] < gap_s:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end, spk])
    return [tuple(t) for t in merged]


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != SR or handle.getsampwidth() != 2:
            raise SystemExit("expected 16 kHz 16-bit wav (AMI Mix-Headset is)")
        frames = handle.readframes(handle.getnframes())
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768
        channels = handle.getnchannels()
    return audio.reshape(-1, channels).mean(axis=1) if channels > 1 else audio


def cosine(a, b) -> float:
    if len(a) == 0 or len(a) != len(b):
        return float("nan")
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def update_centroid(current, incoming, speech_ms):
    if len(current) != len(incoming) or len(current) == 0:
        return cluster.normalize(np.asarray(incoming))
    a = min(0.5, max(0.05, speech_ms / (speech_ms + 20_000)))
    return cluster.normalize((1 - a) * np.asarray(current) + a * np.asarray(incoming))


def match_clusters(profiles, clusters, chunk_start_ms, previous_id, match_sim=MATCH_SIMILARITY):
    """profiles: {id: centroid}; clusters: [(centroid, speech_ms, start_ms)]."""
    result = [None] * len(clusters)
    used = set()
    ids = list(profiles)
    sims = [[cosine(c[0], profiles[p]) for p in ids] for c in clusters]
    pairs = sorted(
        (
            (s, ci, pi)
            for ci, row in enumerate(sims)
            if clusters[ci][1] >= SHORT_CLUSTER_MS
            for pi, s in enumerate(row)
            if s == s
        ),
        reverse=True,
    )
    for s, ci, pi in pairs:
        if result[ci] or ids[pi] in used or s < match_sim:
            continue
        second = max([x for j, x in enumerate(sims[ci]) if j != pi and x == x] or [-1])
        result[ci] = ("match", ids[pi], s - second >= UPDATE_MARGIN)
        used.add(ids[pi])
    for ci, c in enumerate(clusters):
        if result[ci] or c[1] >= SHORT_CLUSTER_MS:
            continue
        best = max(
            ((s, pi) for pi, s in enumerate(sims[ci]) if s == s and ids[pi] not in used),
            default=(-1, -1),
        )
        if best[1] >= 0 and best[0] >= SHORT_MATCH_SIMILARITY:
            result[ci] = ("match", ids[best[1]], False)
            used.add(ids[best[1]])
        elif previous_id and previous_id not in used and c[2] - chunk_start_ms <= CONTINUITY_MS:
            result[ci] = ("match", previous_id, False)
            used.add(previous_id)
    return [r or ("new", None, False) for r in result]


def embed_chunks(audio, turns, chunk_s, engine):
    """Per chunk: segment spans and their embeddings (cached for sweeps)."""
    total_s = len(audio) / SR
    chunks = []
    for c_start in np.arange(0, total_s, chunk_s):
        c_end = min(total_s, c_start + chunk_s)
        segs = []
        for start, end, spk in turns:
            # A turn crossing the boundary is cut, as a recorder would.
            a, b = max(start, c_start), min(end, c_end)
            if b - a <= 0:
                continue
            parts = cluster.windows(a, b)
            vector = None
            if parts:
                embedded = [engine.embed(audio[int(x * SR) : int(y * SR)]) for x, y in parts]
                vector = cluster.weighted_centroid(embedded, [y - x for x, y in parts])
            segs.append({"start": a, "end": b, "ref": spk, "vec": vector})
        chunks.append({"start": c_start, "segs": segs})
    return chunks


def attribute(chunks, merge_sim, match_sim):
    """Runs clustering + cross-chunk matching; returns per-chunk labels."""
    profiles: dict[str, np.ndarray] = {}
    previous = None
    labelled = []
    for chunk in chunks:
        segs = chunk["segs"]
        voiced = [i for i, s in enumerate(segs) if s["vec"] is not None]
        labels = cluster.agglomerate([segs[i]["vec"] for i in voiced], threshold=merge_sim)
        groups: dict[int, list[int]] = {}
        for i, label in zip(voiced, labels):
            groups.setdefault(label, []).append(i)
        clusters = []
        for members in groups.values():
            weights = [segs[i]["end"] - segs[i]["start"] for i in members]
            centroid = cluster.weighted_centroid([segs[i]["vec"] for i in members], weights)
            clusters.append(
                (centroid, sum(weights) * 1000, min(segs[i]["start"] for i in members) * 1000, members)
            )
        matches = match_clusters(
            profiles, [c[:3] for c in clusters], chunk["start"] * 1000, previous, match_sim
        )
        pred = [None] * len(segs)
        for c, (kind, pid, update) in zip(clusters, matches):
            if kind == "new":
                pid = f"S{len(profiles) + 1}"
                profiles[pid] = c[0]
            elif update:
                profiles[pid] = update_centroid(profiles[pid], c[0], c[1])
            for i in c[3]:
                pred[i] = pid
        # unembedded: nearest labelled in chunk, else previous speaker
        for i, s in enumerate(segs):
            if pred[i] is None:
                near = sorted(
                    (abs(segs[j]["start"] - s["start"]), j) for j in range(len(segs)) if pred[j]
                )
                pred[i] = pred[near[0][1]] if near else (previous or "S?")
        if segs:
            previous = pred[max(range(len(segs)), key=lambda i: segs[i]["start"])]
        labelled.append(pred)
    return labelled, len(profiles)


def score(chunks, labelled):
    """Segment-time speaker error under the best 1:1 mapping, and splits."""
    time = {}
    total = 0.0
    for chunk, pred in zip(chunks, labelled):
        for s, p in zip(chunk["segs"], pred):
            d = s["end"] - s["start"]
            total += d
            time[(s["ref"], p)] = time.get((s["ref"], p), 0.0) + d
    refs = sorted({r for r, _ in time})
    preds = sorted({p for _, p in time})
    # Greedy 1:1 mapping by shared time (exact Hungarian needs scipy).
    mapping, used_p, correct = {}, set(), 0.0
    for (r, p), t in sorted(time.items(), key=lambda kv: -kv[1]):
        if r in mapping or p in used_p:
            continue
        mapping[r] = p
        used_p.add(p)
        correct += t
    # Boundary splits: a reference speaker talking at the end of chunk n
    # and the start of chunk n+1 gets a different label across the cut.
    splits = boundaries = 0
    for (c0, p0), (c1, p1) in zip(zip(chunks, labelled), list(zip(chunks, labelled))[1:]):
        if not c0["segs"] or not c1["segs"]:
            continue
        last = max(range(len(c0["segs"])), key=lambda i: c0["segs"][i]["end"])
        first = min(range(len(c1["segs"])), key=lambda i: c1["segs"][i]["start"])
        if c0["segs"][last]["ref"] == c1["segs"][first]["ref"]:
            boundaries += 1
            splits += p0[last] != p1[first]
    return {
        "speaker_error": round(1 - correct / total, 4) if total else None,
        "reference_speakers": len(refs),
        "predicted_speakers": len(preds),
        "boundary_continuations": boundaries,
        "boundary_splits": splits,
    }


def fetch(meeting: str, folder: Path) -> tuple[Path, Path]:
    folder.mkdir(parents=True, exist_ok=True)
    audio = folder / f"{meeting}.Mix-Headset.wav"
    rttm = folder / f"{meeting}.rttm"
    for url, path in ((AMI_AUDIO_URL, audio), (AMI_RTTM_URL, rttm)):
        if not path.exists():
            print(f"downloading {url.format(meeting=meeting)}", file=sys.stderr)
            urllib.request.urlretrieve(url.format(meeting=meeting), path)
    return audio, rttm


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--meeting", default="ES2004a")
    parser.add_argument("--audio")
    parser.add_argument("--rttm")
    parser.add_argument("--minutes", type=float, default=10)
    parser.add_argument("--chunk-seconds", type=float, default=30)
    parser.add_argument("--out", help="write the JSON report here")
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[2]
    if args.fetch:
        audio_path, rttm_path = fetch(args.meeting, root / "recordings" / "benchmark" / "ami")
    else:
        if not (args.audio and args.rttm):
            parser.error("--audio and --rttm, or --fetch")
        audio_path, rttm_path = Path(args.audio), Path(args.rttm)

    limit_s = args.minutes * 60
    audio = read_wav(audio_path)[: int(limit_s * SR)]
    turns = merge_turns(
        [t for t in parse_rttm(rttm_path.read_text()) if t[0] < limit_s]
    )
    speech_s = sum(min(e, limit_s) - s for s, e, _ in turns)

    report = {"meeting": args.meeting, "minutes": args.minutes, "chunk_s": args.chunk_seconds}
    report["rss_mb_before_load"] = rss_mb()

    engine = engines.get_engine()
    t0 = time.perf_counter()
    engine.embed(np.zeros(SR, dtype=np.float32))  # loads the model
    report["load_s"] = round(time.perf_counter() - t0, 2)
    report["rss_mb_after_load"] = rss_mb()
    report["engine"], report["model"] = engine.name, engine.model
    report["threads"] = int(os.getenv("SPEAKER_EMBEDDING_THREADS", "1") or 1)

    t0 = time.perf_counter()
    chunks = embed_chunks(audio, turns, args.chunk_seconds, engine)
    elapsed = time.perf_counter() - t0
    report["embed_s"] = round(elapsed, 2)
    report["rtf_vs_audio"] = round(elapsed / (len(audio) / SR), 4)
    report["rtf_vs_speech"] = round(elapsed / speech_s, 4) if speech_s else None
    report["rss_mb_peak_after_embed"] = rss_mb()
    report["embedding_dim"] = next(
        (len(s["vec"]) for c in chunks for s in c["segs"] if s["vec"] is not None), None
    )

    labelled, _ = attribute(chunks, cluster.MERGE_SIMILARITY, MATCH_SIMILARITY)
    report["default"] = {
        "merge_similarity": cluster.MERGE_SIMILARITY,
        "match_similarity": MATCH_SIMILARITY,
        **score(chunks, labelled),
    }

    sweep = []
    for merge_sim, match_sim in itertools.product(
        (0.3, 0.4, 0.5, 0.6), (0.35, 0.45, 0.55, 0.65)
    ):
        labelled, _ = attribute(chunks, merge_sim, match_sim)
        sweep.append({"merge": merge_sim, "match": match_sim, **score(chunks, labelled)})
    report["sweep"] = sweep

    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text)


if __name__ == "__main__":
    main()
