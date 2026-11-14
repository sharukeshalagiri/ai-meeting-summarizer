import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import { useLiveCapture } from "../hooks/useLiveCapture";
import {
  MEETING_MODES,
  parseHints,
  type MeetingMode,
} from "../lib/capture/contract";
import type { ChannelLevel } from "../lib/capture/levels";
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

/** One channel's level bar plus its 30 s silence warning. */
function LevelMeter({
  label,
  channel,
  off,
}: {
  label: string;
  channel: ChannelLevel;
  off?: boolean;
}) {
  return (
    <div className="stack" style={{ gap: 4, minWidth: 160 }}>
      <span className="muted tiny">
        {label}
        {off ? " (off)" : channel.silent ? " (silent for 30 s)" : ""}
      </span>
      <div
        role="meter"
        aria-label={`${label} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(channel.level * 100)}
        style={{
          height: 6,
          borderRadius: 3,
          background: "rgba(127,127,127,0.25)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${off ? 0 : Math.round(channel.level * 100)}%`,
            height: "100%",
            background: channel.silent ? "#b45309" : "#16a34a",
            transition: "width 120ms linear",
          }}
        />
      </div>
    </div>
  );
}

function LiveMeeting() {
  const navigate = useNavigate();

  const {
    status,
    error,
    warning,
    meeting,
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
    isRecording,
    start,
    stop,
    clearError,
    clearWarning,
  } = useLiveCapture();

  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState<Platform>("GOOGLE_MEET");
  const [mode, setMode] = useState<MeetingMode>("AUTO");
  const [hintsText, setHintsText] = useState("");

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
      mode,
      hints: parseHints(hintsText),
    });
  };

  const handleStop = async () => {
    const ended = await stop();

    // /end has been accepted; MeetingDetails shows the report (or its
    // progress while the summary is still being generated).
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

      {warning && (
        <div role="status" className="alert">
          <span>{warning}</span>
          <button
            type="button"
            className="ghost sm"
            onClick={clearWarning}
            aria-label="Dismiss warning"
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

          <div className="field">
            <label htmlFor="live-mode">Meeting type</label>
            <select
              id="live-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as MeetingMode)}
              disabled={status === "requesting"}
            >
              {MEETING_MODES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="live-hints">Names and terms (optional)</label>
            <textarea
              id="live-hints"
              rows={2}
              placeholder="Priya, Kubernetes, Q3 roadmap"
              value={hintsText}
              onChange={(event) => setHintsText(event.target.value)}
              disabled={status === "requesting"}
            />
            <span className="muted tiny">
              Comma-separated. Helps spell names and jargon correctly.
            </span>
          </div>

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
              <li>
                Allow the microphone so your own voice is recorded on its
                own channel.
              </li>
              <li>Let everyone in the call know it is being recorded.</li>
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
                  {pendingChunks > 0 &&
                    ` · ${pendingChunks} chunk${
                      pendingChunks === 1 ? "" : "s"
                    } waiting`}
                  {pendingChunks > 0 && retryReason && ` (${retryReason})`}
                  {rollingCount > 0 &&
                    ` · ${rollingCount} live summar${
                      rollingCount === 1 ? "y" : "ies"
                    }`}
                </p>
              </div>
            </div>

            {isRecording && (
              <div className="actions" style={{ alignItems: "flex-end" }}>
                <LevelMeter
                  label="You (mic)"
                  channel={levels.mic}
                  off={!micEnabled}
                />
                <LevelMeter label="Meeting (tab)" channel={levels.tab} />
                <button
                  type="button"
                  className="secondary sm"
                  onClick={() => setMicEnabled(!micEnabled)}
                  disabled={!hasMic}
                  aria-pressed={micEnabled}
                >
                  {!hasMic ? "No mic" : micEnabled ? "Mute mic" : "Unmute mic"}
                </button>
              </div>
            )}

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

          {isRecording && (levels.mic.silent || levels.tab.silent) && (
            <div role="status" className="callout">
              {levels.tab.silent && (
                <p>
                  No meeting audio for 30 s. Check that the shared tab is
                  the call and that &quot;Also share tab audio&quot; was on.
                </p>
              )}
              {levels.mic.silent && (
                <p>
                  Your microphone has been silent for 30 s. Check that the
                  right mic is selected and not muted in the system.
                </p>
              )}
            </div>
          )}

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
