from fastapi import FastAPI
from pydantic import BaseModel
import whisper

app = FastAPI()

model = whisper.load_model("base")

class TranscriptRequest(BaseModel):
    file_path: str

@app.post("/transcribe")
def transcribe_audio(request: TranscriptRequest):
    result = model.transcribe(request.file_path)

    return {
        "text": result["text"]
    }