# syntax=docker/dockerfile:1
#
# ai-service (FastAPI + faster-whisper), CPU production image.
#
#   docker build -t meeting-ai ai-service/
#
# - CPU int8 by default (WHISPER_DEVICE=cpu, WHISPER_COMPUTE_TYPE=int8);
#   no torch, no CUDA. Expected size about 450-600 MB (ctranslate2,
#   onnxruntime, PyAV with its bundled ffmpeg libraries, numpy).
# - No Whisper model is baked in. faster-whisper downloads it from the
#   Hugging Face hub on the first transcription into HF_HOME=/models,
#   which docker-compose.prod.yml mounts as a named volume, so the model
#   (about 460 MB for `small`) survives image upgrades and is fetched once.
# - No ffmpeg binary: decoding goes through PyAV, whose wheels bundle
#   the ffmpeg libraries.
# - The service reads audio by absolute path, so it must share the
#   uploads volume with the backend at the same mount path (/app/uploads).

ARG PYTHON_IMAGE=python:3.12.15-slim-bookworm

FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AI_SERVICE_PORT=8000 \
    WHISPER_MODEL=small \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8 \
    HF_HOME=/models
# uid/gid 1000 on purpose: the same as the backend image's `node` user,
# so whichever container mounts the shared uploads volume first, the
# ownership Docker copies into the empty volume works for both.
RUN groupadd --gid 1000 app \
 && useradd --uid 1000 --gid app --home-dir /app --shell /usr/sbin/nologin app \
 && mkdir -p /models /app/uploads \
 && chown app:app /models /app/uploads
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=app:app main.py ./
COPY --chown=app:app asr ./asr
USER app
EXPOSE 8000
# /health never loads the model (it loads lazily), so this stays cheap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('AI_SERVICE_PORT','8000'), timeout=4); sys.exit(0)"]
# One worker: the model is loaded once per process and Whisper already
# uses every core; more workers would multiply RAM for no throughput.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${AI_SERVICE_PORT} --workers 1"]
