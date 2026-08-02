import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getErrorMessage, postData } from "../api/api";
import ErrorState from "../components/ErrorState";
import { Skeleton } from "../components/Skeleton";
import StatusBadge from "../components/StatusBadge";
import SummaryView from "../components/SummaryView";
import TranscriptView from "../components/TranscriptView";
import { useFetch } from "../hooks/useFetch";
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
  } = useFetch<Meeting>(`/meetings/${id}`);

  const { data: segments } = useFetch<Segment[]>(
    `/meetings/${id}/segments`
  );

  const [tab, setTab] = useState<TabKey>(
    focusMs != null ? "transcript" : "summary"
  );
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  /** Lets the user recover a meeting whose pipeline failed midway. */
  const retryProcessing = async () => {
    setRetryError(null);

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

  const isProcessing =
    meeting.status === "PROCESSING" || meeting.status === "LIVE";
  const hasFailed = meeting.status === "FAILED";
  const incomplete = hasFailed || !meeting.summary;

  const duration = formatDuration(meeting.durationSec);

  return (
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
            <StatusBadge status={meeting.status} />

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

      {isProcessing && !retrying && (
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
  );
}

export default MeetingDetails;
