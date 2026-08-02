"""
Whisper transcription service.

Returns timestamped segments alongside the flat text: the backend
needs both, one to summarize and one to attribute to speakers and to
embed for search.
"""

import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import whisper

app = FastAPI(title="AI Meeting Assistant - Speech Service")

# Loaded once at import: the model takes seconds to initialize and is
# safe to reuse across requests.
MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
model = whisper.load_model(MODEL_NAME)


class TranscriptRequest(BaseModel):
    file_path: str
    # Milliseconds to add to every timestamp. Live capture transcribes
    # one chunk at a time, so each chunk's timestamps start at zero and
    # must be shifted into the meeting's timeline.
    offset_ms: int = 0


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/transcribe")
def transcribe_audio(request: TranscriptRequest):
    if not os.path.exists(request.file_path):
        raise HTTPException(
            status_code=400,
            detail=f"Audio file not found: {request.file_path}",
        )

    try:
        result = model.transcribe(request.file_path)
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {exc}"
        ) from exc

    segments = []

    for raw in result.get("segments") or []:
        text = (raw.get("text") or "").strip()

        # Whisper emits empty segments for silence; they carry no
        # information and would show up as blank rows in the reader.
        if not text:
            continue

        segments.append(
            {
                "text": text,
                "startMs": int(raw["start"] * 1000) + request.offset_ms,
                "endMs": int(raw["end"] * 1000) + request.offset_ms,
                # Whisper's confidence proxy. Kept so the backend can
                # drop hallucinated segments from near-silent audio.
                "noSpeechProb": float(raw.get("no_speech_prob") or 0.0),
            }
        )

    duration_ms = segments[-1]["endMs"] - request.offset_ms if segments else 0

    return {
        "text": (result.get("text") or "").strip(),
        "segments": segments,
        "durationMs": duration_ms,
        "language": result.get("language"),
    }
