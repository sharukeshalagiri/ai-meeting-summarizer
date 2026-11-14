import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { API_BASE_URL, getData, getErrorMessage, postData } from "../api/api";
import ErrorState from "../components/ErrorState";
import { Skeleton } from "../components/Skeleton";
import StatusBadge from "../components/StatusBadge";
import SummaryView from "../components/SummaryView";
import TranscriptView from "../components/TranscriptView";
import { useFetch } from "../hooks/useFetch";
import { AudioPlayer } from "../lib/audio/AudioPlayer";
import { AudioPlayerProvider } from "../lib/audio/AudioPlayerProvider";
import type {
  Meeting,
  Segment,
  Summary,
  Transcript,
} from "../types/meeting";
import { formatDate, formatDuration } from "../utils/format";

const TABS = [
  { key: "summary", label: "Summary" },
  { key: "transcript", label: "Transcript" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** How often the page re-reads a meeting whose summary is running. */
const POLL_EVERY_MS = 5_000;

/**
 * When to stop polling and offer a retry. The summary runs in-process
 * on the backend, so a server restart loses it and the stage would stay
 * SUMMARIZING forever (Pair 4 moves it to a job queue).
 */
const POLL_LIMIT_MS = 20 * 60 * 1000;

function MeetingDetails() {
  const { id } = useParams();
  const [params] = useSearchParams();

  // A chat citation links here with the moment it cited.
  const focusMs = params.get("t") ? Number(params.get("t")) : null;

  const {
    data: meeting,
    loading,
    error,
    refetch,
    setData: setMeeting,
  } = useFetch<Meeting>(`/meetings/${id}`);

  // The summary runs in the background after POST /summarize (or live
  // /end); poll quietly (no skeleton) until the stage changes.
  const summarizing = meeting?.processingStage === "SUMMARIZING";
  const [pollExpired, setPollExpired] = useState(false);

  useEffect(() => {
    if (!summarizing || !id) return;

    const startedAt = Date.now();
    let cancelled = false;

    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > POLL_LIMIT_MS) {
        window.clearInterval(timer);
        setPollExpired(true);
        return;
      }

      getData<Meeting>(`/meetings/${id}`)
        .then((next) => {
          if (!cancelled) setMeeting(next);
        })
        .catch((err) => {
          // A missed poll is retried on the next tick.
          console.error(err);
        });
    }, POLL_EVERY_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [summarizing, id, setMeeting]);

  const { data: segments } = useFetch<Segment[]>(
    `/meetings/${id}/segments`
  );

  const [tab, setTab] = useState<TabKey>(
    focusMs != null ? "transcript" : "summary"
  );
  const [retryError, setRetryError] = useState<string | null>(null);

  // jumpToSegment(idx) can seek from any tab, then shows the transcript.
  const segmentStarts = useMemo(
    () => new Map((segments ?? []).map((s) => [s.idx, s.startMs])),
    [segments]
  );
  const showTranscript = useCallback(() => setTab("transcript"), []);
  const [retrying, setRetrying] = useState<string | null>(null);

  /** Lets the user recover a meeting whose pipeline failed midway. */
  const retryProcessing = async () => {
    setRetryError(null);
    setPollExpired(false);

    try {
      if (!meeting?.transcript) {
        setRetrying("Transcribing");
        await postData<Transcript>(
          `/meetings/${id}/transcribe`,
          undefined,
          { timeout: 15 * 60 * 1000 }
        );
      }

      setRetrying("Generating summary");
      await postData<Summary>(`/meetings/${id}/summarize`, undefined, {
        timeout: 10 * 60 * 1000,
      });

      await refetch();
    } catch (err) {
      console.error(err);
      setRetryError(getErrorMessage(err));
    } finally {
      setRetrying(null);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <Skeleton rows={3} />
      </div>
    );
  }

  if (error || !meeting) {
    return (
      <div className="page">
        <p>
          <Link to="/" className="back-link">
            &larr; Back to meetings
          </Link>
        </p>

        <ErrorState
          message={error ?? "Meeting not found."}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  // A summary still marked as running after the poll limit is treated
  // as lost, so the retry button comes back.
  const summaryStuck = summarizing && pollExpired;
  const isProcessing =
    (meeting.status === "PROCESSING" || meeting.status === "LIVE") &&
    !summaryStuck;
  const hasFailed = meeting.status === "FAILED" || summaryStuck;
  // A live capture with no speech has nothing to summarize or retry.
  const noSpeech = meeting.processingStage === "NO_SPEECH";
  const incomplete = !noSpeech && (hasFailed || !meeting.summary);

  const duration = formatDuration(meeting.durationSec);

  return (
    <AudioPlayerProvider
      segmentStarts={segmentStarts}
      onJump={showTranscript}
    >
    <div className="page">
      <p>
        <Link to="/" className="back-link">
          &larr; Back to meetings
        </Link>
      </p>

      <header className="page-header">
        <div>
          <h1>{meeting.title}</h1>

          <p className="muted tiny meta-row">
            <StatusBadge
              status={meeting.status}
              stage={meeting.processingStage}
            />

            {meeting.source === "LIVE" && (
              <span className="chip">Live capture</span>
            )}

            <span>{formatDate(meeting.createdAt)}</span>

            {duration && <span>{duration}</span>}
          </p>
        </div>

        <div className="actions">
          <Link to={`/ask?meetingId=${meeting.id}`}>
            <button type="button" className="secondary sm">
              Ask about this meeting
            </button>
          </Link>
        </div>
      </header>

      {meeting.description && (
        <p className="description">{meeting.description}</p>
      )}

      {meeting.audioPath && (
        <AudioPlayer src={`${API_BASE_URL}/meetings/${meeting.id}/audio`} />
      )}

      {retryError && (
        <div role="alert" className="alert">
          {retryError}
        </div>
      )}

      {retrying && (
        <p className="step step-active">
          <span className="spinner" /> {retrying}...
        </p>
      )}

      {meeting.processingError && !summarizing && (
        <p className="muted tiny" role="status">
          {meeting.processingError}
        </p>
      )}

      {summarizing && !summaryStuck && !retrying && (
        <p className="step step-active" role="status">
          <span className="spinner" /> Summarizing... This can take a few
          minutes; the page updates by itself.
        </p>
      )}

      {isProcessing && !summarizing && !retrying && (
        <div className="card">
          <p>
            {meeting.status === "LIVE"
              ? "This meeting is being captured right now."
              : "This meeting is still being processed."}
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => void refetch()}
          >
            Refresh
          </button>
        </div>
      )}

      {noSpeech && !retrying && (
        <div className="card" role="status">
          <p>
            No speech detected. The capture ended without any transcribed
            speech (often the wrong tab or a muted source). If audio
            arrives late, the summary is generated automatically.
          </p>
        </div>
      )}

      {incomplete && !isProcessing && !retrying && (
        <div className="card">
          <p>
            {hasFailed
              ? "Processing did not finish for this meeting."
              : "This meeting has no summary yet."}
          </p>

          <button type="button" onClick={() => void retryProcessing()}>
            {meeting.transcript ? "Generate summary" : "Retry processing"}
          </button>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Meeting views">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={`tab-${entry.key}`}
            aria-selected={tab === entry.key}
            aria-controls={`panel-${entry.key}`}
            className={`tab ${tab === entry.key ? "is-active" : ""}`}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "summary" && (
        <div
          role="tabpanel"
          id="panel-summary"
          aria-labelledby="tab-summary"
        >
          {meeting.summary?.data ? (
            <SummaryView summary={meeting.summary.data} />
          ) : (
            <div className="content-box">
              {meeting.summary?.content || (
                <span className="muted">Summary not generated.</span>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "transcript" && (
        <div
          role="tabpanel"
          id="panel-transcript"
          aria-labelledby="tab-transcript"
        >
          <TranscriptView
            segments={segments ?? []}
            fallback={meeting.transcript?.content}
            focusMs={focusMs}
          />
        </div>
      )}
    </div>
    </AudioPlayerProvider>
  );
}

export default MeetingDetails;
