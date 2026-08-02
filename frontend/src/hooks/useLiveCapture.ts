import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage, postData } from "../api/api";
import type {
  ChunkResult,
  LiveSession,
  Meeting,
  Platform,
} from "../types/meeting";

/**
 * Browser-tab audio capture for live meetings.
 *
 * The user shares a Meet/Zoom/Teams tab, MediaRecorder slices its
 * audio into fixed chunks, and each chunk is posted to the backend to
 * be transcribed and appended to the meeting. See docs/DECISIONS.md
 * for why this rather than a streaming recognizer.
 */

/**
 * Seconds of audio per chunk.
 *
 * Whisper needs enough context to punctuate a sentence, and each chunk
 * costs a round trip plus a diarization call, so very short chunks get
 * expensive and inaccurate. Twenty seconds keeps the transcript
 * feeling live without either problem.
 */
const CHUNK_MS = 20_000;

export type CaptureStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "ended"
  | "error";

interface LiveTranscriptLine {
  speaker: string;
  text: string;
  startMs: number;
}

/**
 * MediaRecorder needs a container it can actually produce, and support
 * differs between Chrome, Firefox, and Safari. The first supported
 * type wins; an empty string lets the browser choose its default.
 */
const pickMimeType = (): string => {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  return (
    candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ""
  );
};

export function useLiveCapture() {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lines, setLines] = useState<LiveTranscriptLine[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [chunksSent, setChunksSent] = useState(0);
  const [pendingChunks, setPendingChunks] = useState(0);
  const [rollingCount, setRollingCount] = useState(0);

  // Refs, not state: the MediaRecorder callbacks close over these and
  // must see current values without re-subscribing on every render.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);
  /** Serializes uploads so chunks reach the server in order. */
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());

  /** Releases the captured tracks; without this the tab keeps its
   *  "sharing" indicator even after recording stops. */
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const uploadChunk = useCallback(async (blob: Blob) => {
    const currentSession = sessionIdRef.current;

    if (!currentSession || blob.size === 0) return;

    const form = new FormData();

    // The extension matters: the backend passes the file to ffmpeg via
    // Whisper, which infers the container from it.
    form.append("chunk", blob, `chunk-${Date.now()}.webm`);
    form.append("durationMs", String(CHUNK_MS));

    setPendingChunks((count) => count + 1);

    try {
      const result = await postData<ChunkResult>(
        `/live/sessions/${currentSession}/chunks`,
        form,
        {
          headers: { "Content-Type": "multipart/form-data" },
          // Transcription of a 20s chunk is quick, but the service may
          // be busy with another chunk.
          timeout: 5 * 60 * 1000,
        }
      );

      setElapsedMs(result.elapsedMs);
      setChunksSent(result.chunkCount);

      if (result.segments.length) {
        setLines((current) => [...current, ...result.segments]);
      }

      if (result.rollingSummaryGenerated) {
        setRollingCount((count) => count + 1);
      }
    } catch (err) {
      // A dropped chunk loses a few seconds of transcript but must not
      // stop the recording; the user would rather keep the rest.
      console.error("Chunk upload failed", err);

      setError(getErrorMessage(err));
    } finally {
      setPendingChunks((count) => Math.max(0, count - 1));
    }
  }, []);

  /**
   * Stops the capture and finalizes the meeting.
   *
   * Flushes whatever the recorder is holding and waits for every
   * in-flight upload before ending the session, so the final report
   * covers the whole meeting rather than everything but the last few
   * seconds.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    const currentSession = sessionIdRef.current;

    if (!currentSession || stoppingRef.current) return null;

    stoppingRef.current = true;
    setStatus("stopping");

    const recorder = recorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      // requestData emits the partial chunk still being recorded,
      // which stop() alone would discard.
      recorder.requestData();
      recorder.stop();
    }

    recorderRef.current = null;

    releaseStream();

    try {
      await uploadChainRef.current;

      await postData(`/live/sessions/${currentSession}/end`, undefined, {
        // The final report runs summarization over the whole meeting.
        timeout: 10 * 60 * 1000,
      });

      setStatus("ended");

      return currentSession;
    } catch (err) {
      setStatus("error");
      setError(getErrorMessage(err));

      return null;
    }
  }, [releaseStream]);

  const start = useCallback(
    async (input: { title: string; platform: Platform }) => {
      setError(null);
      setStatus("requesting");

      let stream: MediaStream;

      try {
        // Video must be requested for a tab to be offerable at all;
        // Chrome does not list tabs for an audio-only request. The
        // video track is stopped immediately below.
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (err) {
        setStatus("idle");

        // Cancelling the picker is a normal action, not a failure.
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          setError(
            "Screen sharing was cancelled. Pick the meeting tab and " +
              'make sure "Also share tab audio" is enabled.'
          );
        } else {
          setError(getErrorMessage(err));
        }

        return null;
      }

      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());

        setStatus("idle");
        setError(
          'No audio was shared. Re-share the tab and turn on "Also ' +
            'share tab audio" — without it there is nothing to ' +
            "transcribe."
        );

        return null;
      }

      // Only the audio is needed; keeping the video track alive would
      // waste bandwidth and memory for the whole meeting.
      stream.getVideoTracks().forEach((track) => track.stop());

      try {
        const { meeting: created, session } = await postData<{
          meeting: Meeting;
          session: LiveSession;
        }>("/live/sessions", {
          title: input.title,
          platform: input.platform,
        });

        setMeeting(created);
        setSessionId(session.id);
        sessionIdRef.current = session.id;

        streamRef.current = stream;
        stoppingRef.current = false;

        const mimeType = pickMimeType();

        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined
        );

        recorder.ondataavailable = (event) => {
          if (event.data.size === 0) return;

          // Chained rather than fired in parallel: chunk N's
          // timestamps are offset by the elapsed time chunk N-1
          // recorded, so order matters.
          uploadChainRef.current = uploadChainRef.current.then(() =>
            uploadChunk(event.data)
          );
        };

        // The user can also stop sharing from Chrome's own banner,
        // which ends the track without touching our UI.
        stream.getAudioTracks()[0]?.addEventListener("ended", () => {
          if (!stoppingRef.current) {
            void stop();
          }
        });

        recorder.start(CHUNK_MS);
        recorderRef.current = recorder;

        setLines([]);
        setElapsedMs(0);
        setChunksSent(0);
        setRollingCount(0);
        setStatus("recording");

        return created;
      } catch (err) {
        stream.getTracks().forEach((track) => track.stop());

        setStatus("error");
        setError(getErrorMessage(err));

        return null;
      }
    },
    [uploadChunk, stop]
  );

  // A refresh or navigation mid-capture would otherwise leave the tab
  // sharing indefinitely.
  useEffect(
    () => () => {
      const recorder = recorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      releaseStream();
    },
    [releaseStream]
  );

  return {
    status,
    error,
    meeting,
    sessionId,
    lines,
    elapsedMs,
    chunksSent,
    pendingChunks,
    rollingCount,
    isRecording: status === "recording",
    start,
    stop,
    clearError: () => setError(null),
  };
}
