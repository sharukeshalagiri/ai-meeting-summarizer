import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import { useLiveCapture } from "../hooks/useLiveCapture";
import type { Platform } from "../types/meeting";

const PLATFORMS: { value: Platform; label: string; hint: string }[] = [
  {
    value: "GOOGLE_MEET",
    label: "Google Meet",
    hint: "meet.google.com",
  },
  { value: "ZOOM", label: "Zoom", hint: "zoom.us in the browser" },
  {
    value: "MICROSOFT_TEAMS",
    label: "Microsoft Teams",
    hint: "teams.microsoft.com",
  },
  { value: "OTHER", label: "Other", hint: "any tab with audio" },
];

/** mm:ss for the running timer. */
const formatElapsed = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

function LiveMeeting() {
  const navigate = useNavigate();

  const {
    status,
    error,
    meeting,
    lines,
    elapsedMs,
    chunksSent,
    pendingChunks,
    rollingCount,
    isRecording,
    start,
    stop,
    clearError,
  } = useLiveCapture();

  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState<Platform>("GOOGLE_MEET");

  const transcriptRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Follow the transcript as it grows, but stop fighting the user if
  // they have scrolled up to read something earlier.
  useEffect(() => {
    const box = transcriptRef.current;

    if (box && atBottomRef.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [lines]);

  const onTranscriptScroll = () => {
    const box = transcriptRef.current;

    if (!box) return;

    atBottomRef.current =
      box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  };

  /** Consecutive lines from one speaker read better merged. */
  const grouped = useMemo(() => {
    const groups: {
      speaker: string;
      text: string;
      startMs: number;
    }[] = [];

    for (const line of lines) {
      const last = groups[groups.length - 1];

      if (last && last.speaker === line.speaker) {
        last.text = `${last.text} ${line.text}`;
      } else {
        groups.push({ ...line });
      }
    }

    return groups;
  }, [lines]);

  const handleStart = async () => {
    await start({
      title: title.trim() || "Live meeting",
      platform,
    });
  };

  const handleStop = async () => {
    const ended = await stop();

    // The report is ready by the time stop() resolves, so go straight
    // to it rather than making the user find the meeting.
    if (ended && meeting) {
      navigate(`/meeting/${meeting.id}`);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Live meeting</h1>
          <p className="muted">
            Capture a meeting straight from your browser. Nothing is
            installed and no meeting bot joins the call.
          </p>
        </div>
      </header>

      {error && (
        <div role="alert" className="alert">
          <span>{error}</span>
          <button
            type="button"
            className="ghost sm"
            onClick={clearError}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

      {status === "idle" || status === "requesting" ? (
        <div className="card stack">
          <div className="field">
            <label htmlFor="live-title">Meeting title</label>
            <input
              id="live-title"
              type="text"
              placeholder="Sprint planning"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={status === "requesting"}
            />
          </div>

          <fieldset className="field">
            <legend>Platform</legend>

            <div className="radio-grid">
              {PLATFORMS.map((option) => (
                <label
                  key={option.value}
                  className={`radio-card ${
                    platform === option.value ? "is-selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="platform"
                    value={option.value}
                    checked={platform === option.value}
                    onChange={() => setPlatform(option.value)}
                    disabled={status === "requesting"}
                  />
                  <span className="radio-card-label">{option.label}</span>
                  <span className="radio-card-hint">{option.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="callout">
            <strong>Before you start</strong>
            <ol className="tight-list">
              <li>Open your meeting in another browser tab.</li>
              <li>
                Choose that tab when the share dialog appears — pick the{" "}
                <strong>tab</strong>, not a window or your whole screen.
              </li>
              <li>
                Turn on <strong>Also share tab audio</strong>. Without
                it there is no audio to transcribe.
              </li>
            </ol>
          </div>

          <div className="actions">
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={status === "requesting"}
            >
              {status === "requesting"
                ? "Waiting for permission..."
                : "Start AI assistant"}
            </button>

            <button
              type="button"
              className="secondary"
              onClick={() => navigate("/")}
              disabled={status === "requesting"}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card live-bar">
            <div className="live-status">
              {isRecording ? (
                <span className="rec-dot" aria-hidden="true" />
              ) : null}

              <div>
                <strong>
                  {isRecording
                    ? "Recording"
                    : status === "stopping"
                      ? "Finishing up"
                      : status === "ended"
                        ? "Meeting ended"
                        : "Stopped"}
                </strong>

                <p className="muted tiny">
                  {formatElapsed(elapsedMs)} captured &middot;{" "}
                  {chunksSent} chunk{chunksSent === 1 ? "" : "s"}
                  {pendingChunks > 0 && ` · ${pendingChunks} uploading`}
                  {rollingCount > 0 &&
                    ` · ${rollingCount} live summar${
                      rollingCount === 1 ? "y" : "ies"
                    }`}
                </p>
              </div>
            </div>

            <div className="actions">
              {isRecording && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void handleStop()}
                >
                  Stop &amp; summarize
                </button>
              )}

              {status === "stopping" && (
                <button type="button" disabled>
                  <span className="spinner" /> Generating report...
                </button>
              )}

              {status === "ended" && (
                <button type="button" onClick={() => navigate("/")}>
                  View meetings
                </button>
              )}
            </div>
          </div>

          <section>
            <h2>Live transcript</h2>

            <div
              className="content-box transcript-live"
              ref={transcriptRef}
              onScroll={onTranscriptScroll}
              aria-live="polite"
              aria-label="Live transcript"
            >
              {grouped.length === 0 ? (
                <p className="muted">
                  {isRecording
                    ? "Listening... the first lines appear once a chunk " +
                      "has been transcribed."
                    : "Nothing was captured."}
                </p>
              ) : (
                grouped.map((line, index) => (
                  <p key={index} className="transcript-line">
                    <span className="speaker-chip">{line.speaker}</span>
                    <span>{line.text}</span>
                  </p>
                ))
              )}
            </div>
          </section>

          {status === "stopping" && (
            <EmptyState
              title="Building your meeting report"
              body="Transcribing the last few seconds and summarizing the whole meeting. This takes a moment."
            />
          )}
        </>
      )}
    </div>
  );
}

export default LiveMeeting;
