"""
Transcription engine for the speech service.

faster-whisper is imported lazily (inside functions), never at import
time, so /health answers on boot and the tests can install a fake
`faster_whisper` module without torch, CTranslate2 or a model download.
"""
