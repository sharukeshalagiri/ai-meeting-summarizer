"""
Voice-based speaker diarization for the remote channel (w2-spk).

Segments come from the ASR pass; this package embeds each one with a
speaker-embedding model, clusters the embeddings within the request,
and returns one centroid per cluster. Matching clusters across live
chunks (stable "Speaker N" labels) happens in the backend, against the
meeting's SpeakerProfile centroids.
"""
