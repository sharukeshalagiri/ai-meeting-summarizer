import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getErrorMessage, postData } from "../api/api";
import StatusBadge from "../components/StatusBadge";
import SummaryView from "../components/SummaryView";
import { useFetch } from "../hooks/useFetch";
import type { Meeting, Summary, Transcript } from "../types/meeting";

function MeetingDetails() {
  const { id } = useParams();

  const {
    data: meeting,
    loading,
    error,
    refetch,
  } = useFetch<Meeting>(`/meetings/${id}`);

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

      setRetrying("Generating Summary");
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
        <p className="muted">Loading meeting...</p>
      </div>
    );
  }

  if (error || !meeting) {
    return (
      <div className="page">
        <p>
          <Link to="/">&larr; Back to dashboard</Link>
        </p>

        <div role="alert" className="alert">
          {error ?? "Meeting not found."}
        </div>

        <button className="secondary" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const isProcessing = meeting.status === "PROCESSING";
  const hasFailed = meeting.status === "FAILED";
  const incomplete = hasFailed || !meeting.summary;

  return (
    <div className="page">
      <p>
        <Link to="/">&larr; Back to dashboard</Link>
      </p>

      <div className="header-row">
        <h1 style={{ margin: 0 }}>{meeting.title}</h1>

        <StatusBadge status={meeting.status} />
      </div>

      {meeting.description && <p>{meeting.description}</p>}

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
          <p>This meeting is still being processed.</p>
          <button className="secondary" onClick={() => void refetch()}>
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

          <button onClick={() => void retryProcessing()}>
            {meeting.transcript
              ? "Generate summary"
              : "Retry processing"}
          </button>
        </div>
      )}

      <hr />

      <h2>Transcript</h2>

      <div className="content-box">
        {meeting.transcript?.content || (
          <span className="muted">Transcript not generated.</span>
        )}
      </div>

      <hr />

      <h2>AI Summary</h2>

      {meeting.summary?.data ? (
        <div className="content-box">
          <SummaryView summary={meeting.summary.data} />
        </div>
      ) : (
        <div className="content-box">
          {meeting.summary?.content || (
            <span className="muted">Summary not generated.</span>
          )}
        </div>
      )}
    </div>
  );
}

export default MeetingDetails;
