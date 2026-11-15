import { useEffect, useRef, useState } from "react";
import { getData } from "../../api/api";
import { meetingEventsUrl } from "../../api/w3-jobs";
import type { MeetingProgress } from "../../types/w3-jobs";
import { isSettled } from "./stages";

/** Polling interval when Server-Sent Events are not available. */
const POLL_EVERY_MS = 5_000;
/** Consecutive stream errors before giving up on SSE for this run. */
const MAX_STREAM_ERRORS = 3;

interface Options {
  /** Follow only while true (e.g. a run was started or is active). */
  enabled: boolean;
  /** Called once when the run settles (DONE, FAILED, NO_SPEECH, ...). */
  onSettled?: (row: MeetingProgress) => void;
}

/**
 * Follows a meeting's processing over GET /meetings/:id/events, and
 * falls back to polling GET /meetings/:id when the stream cannot be
 * used (no EventSource, a proxy that drops it, a 503 while the queue is
 * down). Stops when the run settles. A backend restart in the middle is
 * fine: the job resumes from the queue and the stream reconnects.
 */
export function useMeetingProgress(
  meetingId: string | undefined,
  { enabled, onSettled }: Options
): { progress: MeetingProgress | null } {
  const [progress, setProgress] = useState<MeetingProgress | null>(null);

  // Kept in a ref so a new callback each render does not restart the stream.
  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    if (!enabled || !meetingId) return;

    let stopped = false;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let errors = 0;

    const stop = () => {
      stopped = true;
      source?.close();
      window.clearInterval(timer);
    };

    const accept = (row: MeetingProgress) => {
      if (stopped) return;
      setProgress(row);

      if (isSettled(row)) {
        stop();
        settledRef.current?.(row);
      }
    };

    const poll = () => {
      source?.close();
      source = null;

      const tick = () =>
        getData<MeetingProgress>(`/meetings/${meetingId}`)
          .then(accept)
          // A missed poll is retried on the next tick.
          .catch((err) => console.error(err));

      void tick();
      timer = window.setInterval(() => void tick(), POLL_EVERY_MS);
    };

    if (typeof EventSource === "undefined") {
      poll();
    } else {
      // w4-acct: the stream is authenticated by the session cookie.
      source = new EventSource(meetingEventsUrl(meetingId), { withCredentials: true });

      source.addEventListener("progress", (event) => {
        errors = 0;
        try {
          accept(JSON.parse((event as MessageEvent<string>).data) as MeetingProgress);
        } catch (err) {
          console.error(err);
        }
      });

      // The server closes the stream itself once settled.
      source.addEventListener("end", () => source?.close());

      source.onerror = () => {
        if (stopped) return;
        errors += 1;
        // CLOSED: the server answered with an error status (503, 404),
        // so the browser will not reconnect. Otherwise it retries by
        // itself, until too many errors in a row.
        if (source?.readyState === EventSource.CLOSED || errors >= MAX_STREAM_ERRORS) {
          poll();
        }
      };
    }

    return stop;
  }, [enabled, meetingId]);

  return { progress };
}
