"""
POST /diarize and GET /diarize/health, registered in main.py with
app.include_router(diarization_router).
"""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import engines
from .pipeline import diarize_file

router = APIRouter()

CHANNEL_LAYOUTS = ("mono", "stereo-mic-left")
# A live chunk has tens of segments; a whole upload a few thousand.
MAX_SEGMENTS = 5000


class Span(BaseModel):
    startMs: int
    endMs: int


class DiarizeRequest(BaseModel):
    # Absolute path on the filesystem shared with the backend.
    file_path: str
    # Where this file starts on the meeting timeline (segment times are
    # meeting times, like /transcribe's output).
    offset_ms: int = 0
    channel_layout: str = "mono"
    # Remote-channel segments only; the mic is "me" without a model.
    segments: list[Span] = Field(default_factory=list)


@router.get("/diarize/health")
def diarize_health():
    engine = engines.get_engine()
    loaded = getattr(engine, "is_loaded", lambda: False)()
    return {"engine": engine.name, "model": engine.model, "loaded": loaded}


@router.post("/diarize")
async def diarize(body: DiarizeRequest):
    if not os.path.exists(body.file_path):
        raise HTTPException(status_code=400, detail=f"Audio file not found: {body.file_path}")
    if body.channel_layout not in CHANNEL_LAYOUTS:
        raise HTTPException(
            status_code=400, detail=f"Unknown channel_layout: {body.channel_layout}"
        )
    if len(body.segments) > MAX_SEGMENTS:
        raise HTTPException(status_code=400, detail="Too many segments")

    try:
        engine = engines.get_engine()
        # Embedding is CPU bound and blocking; keep /health responsive.
        return await run_in_threadpool(
            diarize_file,
            body.file_path,
            max(0, body.offset_ms),
            body.channel_layout,
            [s.model_dump() for s in body.segments],
            engine,
        )
    except engines.EngineUnavailable as exc:
        # 503 tells the backend to fall back to text diarization.
        raise HTTPException(status_code=503, detail=f"Diarization unavailable: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller
        raise HTTPException(status_code=500, detail=f"Diarization failed: {exc}") from exc
