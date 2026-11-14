"""
Whisper transcription service (faster-whisper).

Returns timestamped segments alongside the flat text: the backend
needs both, one to summarize and one to attribute to speakers and to
embed for search. The engine itself lives in asr/ (see asr/pipeline.py).
"""

import json
import os
import tempfile

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ValidationError

from asr import engine
from asr.pipeline import CHANNEL_LAYOUTS, transcribe_file

app = FastAPI(title="AI Meeting Assistant - Speech Service")

MODEL_NAME = engine.MODEL_NAME

# Loaded on first transcription rather than at import, so /health
# answers immediately on boot and tests can import the app without
# downloading a model. The model is reused across requests.
get_model = engine.get_model


class TranscriptRequest(BaseModel):
    # Absolute path on a filesystem shared with the backend. Optional
    # because the audio may instead arrive as a multipart upload.
    file_path: str | None = None
    # Milliseconds to add to every timestamp. Live capture transcribes
    # one chunk at a time, so each chunk's timestamps start at zero and
    # must be shifted into the meeting's timeline.
    offset_ms: int = 0
    # Capture contract layout: "stereo-mic-left" (left = mic, right =
    # everyone else) is transcribed per channel; "mono" as one stream.
    channel_layout: str = "mono"
    # Vocabulary hints (roster names first, then session hints).
    hints: list[str] = []
    # ISO 639-1 code; None auto-detects (or uses WHISPER_LANGUAGE).
    language: str | None = None
    # Tail words of the previous chunk ([{w, startMs, endMs, channel?}]),
    # used to drop words repeated across the chunk boundary.
    previous_words: list[dict] = []


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "loaded": engine.is_loaded()}


def _form_list(form, name: str) -> list:
    """A repeated form field, or one field holding a JSON array."""
    values = form.getlist(name)
    if len(values) == 1 and isinstance(values[0], str) and values[0].startswith("["):
        parsed = json.loads(values[0])
        return parsed if isinstance(parsed, list) else []
    return [v for v in values if isinstance(v, str)]


async def _read_request(request: Request):
    """
    Accepts JSON {file_path, ...} or multipart with an `audio` file plus
    the same fields as form values. Returns (TranscriptRequest, temp path
    to delete afterwards or None).
    """
    content_type = request.headers.get("content-type", "")

    if not content_type.startswith("multipart/form-data"):
        try:
            return TranscriptRequest.model_validate(await request.json()), None
        except (ValidationError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=f"Invalid request: {exc}") from exc

    form = await request.form()
    upload = form.get("audio")

    if upload is None or isinstance(upload, str):
        raise HTTPException(status_code=400, detail="Multipart field `audio` is required.")

    suffix = os.path.splitext(upload.filename or "")[1][:10]
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await upload.read())
        temp_path = tmp.name

    try:
        parsed = TranscriptRequest.model_validate(
            {
                "file_path": temp_path,
                "offset_ms": form.get("offset_ms") or 0,
                "channel_layout": form.get("channel_layout") or "mono",
                "hints": _form_list(form, "hints"),
                "language": form.get("language") or None,
                "previous_words": _form_list(form, "previous_words"),
            }
        )
    except (ValidationError, ValueError) as exc:
        os.unlink(temp_path)
        raise HTTPException(status_code=422, detail=f"Invalid request: {exc}") from exc

    return parsed, temp_path


@app.post("/transcribe")
async def transcribe_audio(request: Request):
    body, temp_path = await _read_request(request)

    try:
        if not body.file_path or not os.path.exists(body.file_path):
            raise HTTPException(
                status_code=400,
                detail=f"Audio file not found: {body.file_path}",
            )

        if body.channel_layout not in CHANNEL_LAYOUTS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown channel_layout: {body.channel_layout}",
            )

        try:
            # Whisper is CPU/GPU bound and blocking; keep the event loop
            # free so /health still answers during a long transcription.
            return await run_in_threadpool(
                transcribe_file,
                body.file_path,
                offset_ms=max(0, body.offset_ms),
                channel_layout=body.channel_layout,
                hints=body.hints,
                language=body.language,
                previous_words=body.previous_words,
            )
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller
            raise HTTPException(
                status_code=500, detail=f"Transcription failed: {exc}"
            ) from exc
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

# w2-spk: speaker diarization (POST /diarize).
from diarization.routes import router as diarization_router  # noqa: E402

app.include_router(diarization_router)
