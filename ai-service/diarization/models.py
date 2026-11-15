"""
Speaker-embedding model registry and download.

Weights are never committed. They are downloaded on first use from the
sherpa-onnx GitHub release (public, no account or token needed), checked
against the release's published SHA-256, and cached in
`diarization/.models/` (gitignored) or SPEAKER_MODEL_DIR.

Licences: the WeSpeaker VoxCeleb models are CC BY 4.0 (WeSpeaker
docs/pretrained.md: "the pretrained model on VoxCeleb follows Creative
Commons Attribution 4.0 International License"), which allows any use
with attribution. Attribution lives in docs/decisions/w2-spk.md.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path

RELEASE_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models"
)


@dataclass(frozen=True)
class ModelSpec:
    name: str
    file: str
    sha256: str
    size: int
    licence: str

    @property
    def url(self) -> str:
        return f"{RELEASE_URL}/{self.file}"


MODELS: dict[str, ModelSpec] = {
    # Default: WeSpeaker ResNet34 with large-margin fine-tuning ("LM"),
    # which WeSpeaker notes "could perform better on long audios, e.g. >3s".
    # 256-d embeddings, ~26.5 MB, trained on VoxCeleb (English).
    "wespeaker_en_voxceleb_resnet34_LM": ModelSpec(
        name="wespeaker_en_voxceleb_resnet34_LM",
        file="wespeaker_en_voxceleb_resnet34_LM.onnx",
        sha256="e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
        size=26_530_550,
        licence="CC BY 4.0 (WeSpeaker, VoxCeleb)",
    ),
}

DEFAULT_MODEL = "wespeaker_en_voxceleb_resnet34_LM"

_download_lock = threading.Lock()


def model_name() -> str:
    return os.getenv("SPEAKER_EMBEDDING_MODEL", "").strip() or DEFAULT_MODEL


def model_dir() -> Path:
    configured = os.getenv("SPEAKER_MODEL_DIR", "").strip()
    return Path(configured) if configured else Path(__file__).resolve().parent / ".models"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_model(name: str | None = None, fetch=urllib.request.urlretrieve) -> Path:
    """
    Local path of the model's .onnx file, downloading it if missing.

    `name` may also be a path to a local .onnx file (bring your own
    model); it is used as is. `fetch(url, path)` is injectable for tests.
    """
    name = name or model_name()

    if name.endswith(".onnx"):
        path = Path(name)
        if not path.is_file():
            raise FileNotFoundError(f"Speaker model not found: {name}")
        return path

    spec = MODELS.get(name)
    if spec is None:
        raise ValueError(
            f"Unknown SPEAKER_EMBEDDING_MODEL {name!r}; known: {', '.join(MODELS)}"
        )

    target = model_dir() / spec.file

    with _download_lock:
        if target.is_file():
            return target

        target.parent.mkdir(parents=True, exist_ok=True)
        # Download beside the target, verify, then rename, so a crash
        # mid-download never leaves a truncated model in place.
        handle, temp_name = tempfile.mkstemp(dir=target.parent, suffix=".part")
        os.close(handle)
        temp = Path(temp_name)
        try:
            fetch(spec.url, str(temp))
            actual = _sha256(temp)
            if actual != spec.sha256:
                raise RuntimeError(
                    f"Checksum mismatch for {spec.file}: expected {spec.sha256}, got {actual}"
                )
            os.replace(temp, target)
        finally:
            if temp.exists():
                temp.unlink()

    return target
