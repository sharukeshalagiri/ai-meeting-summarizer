import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL, getErrorMessage } from "../api/api";
import {
  createCaptureClient,
  type ChunkSegment,
  type MeetingMode,
} from "../lib/capture/contract";
import type { Levels } from "../lib/capture/levels";
import {
  getMicStream,
  startCaptureSession,
  type CaptureSession,
} from "../lib/capture/session";
import { createDefaultStore } from "../lib/capture/uploadQueue";
import type { Platform } from "../types/meeting";

/**
 * Browser-tab capture for live meetings, on the capture contract
 * (docs/CAPTURE_CONTRACT.md).
 *
 * The user shares the meeting tab (right channel = everyone else) and
 * the mic is opened separately (left channel = the user), so the
 * backend can tell "me" from "them" without guessing. Chunks are 20 s
 * standalone files kept in IndexedDB until the server confirms them;
 * see lib/capture/ for the pieces and docs/decisions/w1-ext.md for why.
 */

export type CaptureStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "ended"
  | "error";

export interface LiveMeetingInfo {
  id: string;
}

/** How long stop() waits for the backlog before ending the session. */
const FLUSH_TIMEOUT_MS = 2 * 60_000;

const DEVICE_TOKEN = import.meta.env.VITE_DEVICE_TOKEN as string | undefined;

const SILENT_LEVELS: Levels = {
  mic: { level: 0, silent: false },
  tab: { level: 0, silent: false },
};

export function useLiveCapture() {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<LiveMeetingInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChunkSegment[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [chunksSent, setChunksSent] = useState(0);
  const [pendingChunks, setPendingChunks] = useState(0);
  const [retryReason, setRetryReason] = useState<string | null>(null);
  const [rollingCount, setRollingCount] = useState(0);
  const [levels, setLevels] = useState<Levels>(SILENT_LEVELS);
  const [micEnabled, setMicEnabledState] = useState(false);
  const [hasMic, setHasMic] = useState(false);

  const captureRef = useRef<CaptureSession | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);
  const clientRef = useRef(
    createCaptureClient({ apiBase: API_BASE_URL, token: DEVICE_TOKEN })
  );

  // The UI timer follows the recording clock, not upload progress, so
  // it keeps moving while chunks wait in the queue.
  useEffect(() => {
    if (status !== "recording") return;

    const id = setInterval(() => {
      const capture = captureRef.current;

      if (capture) setElapsedMs(capture.elapsedMs());
    }, 500);

    return () => clearInterval(id);
  }, [status]);

  /**
   * Stops the capture and finalizes the meeting. Waits for the queued
   * chunks first so the report covers the whole meeting.
   */
  const stop = useCallback(async (): Promise<string | null> => {
    const currentSession = sessionIdRef.current;
    const capture = captureRef.current;

    if (!currentSession || !capture || stoppingRef.current) return null;

    stoppingRef.current = true;
    setStatus("stopping");

    const remaining = await capture.stop(FLUSH_TIMEOUT_MS);

    captureRef.current = null;

    if (remaining > 0) {
      // Ending now makes the server refuse these (410); waiting longer
      // blocks the user. The report is what they asked for.
      setWarning(
        `${remaining} chunk${remaining === 1 ? "" : "s"} could not be ` +
          "uploaded in time and are missing from the transcript."
      );
    }

    try {
      await clientRef.current.endSession(currentSession);
      setStatus("ended");

      return currentSession;
    } catch (err) {
      setStatus("error");
      setError(getErrorMessage(err));

      return null;
    }
  }, []);

  const start = useCallback(
    async (input: {
      title: string;
      platform: Platform;
      mode: MeetingMode;
      hints: string[];
    }) => {
      setError(null);
      setWarning(null);
      setStatus("requesting");

      let tab: MediaStream;

      try {
        // Video must be requested for a tab to be offerable at all;
        // Chrome does not list tabs for an audio-only request. The
        // video track is stopped right after.
        tab = await navigator.mediaDevices.getDisplayMedia({
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

      if (tab.getAudioTracks().length === 0) {
        tab.getTracks().forEach((track) => track.stop());

        setStatus("idle");
        setError(
          'No audio was shared. Re-share the tab and turn on "Also ' +
            'share tab audio"; without it there is nothing to ' +
            "transcribe."
        );

        return null;
      }

      tab.getVideoTracks().forEach((track) => track.stop());

      const mic = await getMicStream();

      if (!mic) {
        setWarning(
          "Microphone unavailable: only the meeting audio is recorded, " +
            "so your own voice will be missing."
        );
      }

      try {
        const created = await clientRef.current.startSession({
          title: input.title,
          platform: input.platform,
          source: "WEB",
          mode: input.mode,
          hints: input.hints,
        });

        sessionIdRef.current = created.sessionId;
        stoppingRef.current = false;

        setSessionId(created.sessionId);
        setMeeting({ id: created.meetingId });
        setLines([]);
        setElapsedMs(0);
        setChunksSent(0);
        setRollingCount(0);

        const capture = startCaptureSession({
          sessionId: created.sessionId,
          client: clientRef.current,
          store: createDefaultStore(),
          tab,
          mic,
          // getDisplayMedia leaves the tab audible; playing it again echoes.
          playTab: false,
          onLevels: setLevels,
          onQueue: (state) => {
            setPendingChunks(state.pending);
            setRetryReason(state.lastRetry);

            if (state.halted && state.halted !== "disposed") {
              setError(`Uploads paused: ${state.halted}.`);
            }
          },
          onUploaded: (result) => {
            setChunksSent(result.chunkCount);

            if (result.segments.length) {
              // Retries can land out of order; idx orders by seq.
              setLines((current) =>
                [...current, ...result.segments].sort((a, b) => a.idx - b.idx)
              );
            }

            if (result.rollingSummaryGenerated) {
              setRollingCount((count) => count + 1);
            }
          },
          onSessionEnded: (dropped) =>
            setError(
              `The server ended this session; ${dropped} chunk(s) were not transcribed.`
            ),
          onError: setError,
        });

        captureRef.current = capture;
        setHasMic(capture.mix.hasMic);
        setMicEnabledState(capture.mix.isMicEnabled());

        // The user can also stop sharing from Chrome's own banner,
        // which ends the track without touching our UI.
        tab.getAudioTracks()[0]?.addEventListener("ended", () => {
          if (!stoppingRef.current) void stop();
        });

        setStatus("recording");

        return created;
      } catch (err) {
        tab.getTracks().forEach((track) => track.stop());
        mic?.getTracks().forEach((track) => track.stop());

        setStatus("error");
        setError(getErrorMessage(err));

        return null;
      }
    },
    [stop]
  );

  const setMicEnabled = useCallback((enabled: boolean) => {
    captureRef.current?.setMicEnabled(enabled);
    setMicEnabledState(captureRef.current?.mix.isMicEnabled() ?? false);
  }, []);

  // A refresh or navigation mid-capture would otherwise leave the tab
  // sharing. Queued chunks stay in IndexedDB; the idle reaper ends the
  // session server-side.
  useEffect(
    () => () => {
      void captureRef.current?.stop(0);
    },
    []
  );

  return {
    status,
    error,
    warning,
    meeting,
    sessionId,
    lines,
    elapsedMs,
    chunksSent,
    pendingChunks,
    retryReason,
    rollingCount,
    levels,
    hasMic,
    micEnabled,
    setMicEnabled,
    isRecording: status === "recording",
    start,
    stop,
    clearError: () => setError(null),
    clearWarning: () => setWarning(null),
  };
}
