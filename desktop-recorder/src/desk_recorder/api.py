"""HTTP client for the capture contract (docs/CAPTURE_CONTRACT.md).

Returns status + envelope `data` and leaves the decision of what a status
means to the uploader, so the retry policy lives in one place.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

from desk_recorder.config import SOURCE


class NetworkError(RuntimeError):
    """The backend could not be reached (or the request timed out)."""


@dataclass(frozen=True)
class ApiResponse:
    status: int
    data: Any = None
    message: str = ""

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class ApiClient:
    #: Chunk uploads wait for Whisper + diarization before the backend
    #: answers. If this expires the backend keeps working and a retry gets
    #: 409 (still processing) and later 200 duplicate:true, so a timeout
    #: is safe, just slower.
    CHUNK_TIMEOUT_S = 300
    JSON_TIMEOUT_S = 30

    def __init__(self, api_url: str, device_token: str = "",
                 http: requests.Session | None = None) -> None:
        self.api_url = api_url.rstrip("/")
        self.device_token = device_token
        self.http = http or requests.Session()

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.device_token}"} if self.device_token else {}

    def _send(self, method: str, path: str, timeout: float, **kwargs: Any) -> ApiResponse:
        url = f"{self.api_url}/live{path}"
        try:
            res = self.http.request(method, url, headers=self._headers(), timeout=timeout, **kwargs)
        except requests.RequestException as exc:
            raise NetworkError(f"{method} {path}: {exc.__class__.__name__}") from exc
        try:
            body = res.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            return ApiResponse(res.status_code, body.get("data"), str(body.get("message") or ""))
        return ApiResponse(res.status_code)

    def create_session(self, title: str, platform: str, mode: str,
                       hints: list[str]) -> ApiResponse:
        payload = {"title": title[:200], "platform": platform, "source": SOURCE,
                   "mode": mode, "hints": hints[:20]}
        return self._send("POST", "/sessions", self.JSON_TIMEOUT_S, json=payload)

    def upload_chunk(self, session_id: str, *, seq: int, start_offset_ms: int,
                     duration_ms: int, channel_layout: str, audio: Path,
                     mime_type: str) -> ApiResponse:
        fields = {"seq": str(seq), "startOffsetMs": str(start_offset_ms),
                  "durationMs": str(duration_ms), "channelLayout": channel_layout}
        with open(audio, "rb") as fh:
            files = {"audio": (audio.name, fh, mime_type)}
            return self._send("POST", f"/sessions/{session_id}/chunks", self.CHUNK_TIMEOUT_S,
                              data=fields, files=files)

    def end_session(self, session_id: str) -> ApiResponse:
        return self._send("POST", f"/sessions/{session_id}/end", self.CHUNK_TIMEOUT_S, json={})
