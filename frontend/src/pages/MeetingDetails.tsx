import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { API_BASE_URL, getData, getErrorMessage } from "../api/api";
import { retryProcessing } from "../api/processing";
import ErrorState from "../components/ErrorState";
import ProgressSteps from "../components/progress/ProgressSteps";
import {
  failedStage,
  failureMessage,
  isActiveStage,
} from "../components/progress/stages";
import { useMeetingProgress } from "../components/progress/useMeetingProgress";
import { Skeleton } from "../components/Skeleton";
import StatusBadge from "../components/StatusBadge";
import SummaryView from "../components/SummaryView";
import TranscriptView from "../components/TranscriptView";
import { useFetch } from "../hooks/useFetch";
import { AudioPlayer } from "../lib/audio/AudioPlayer";
import { AudioPlayerProvider } from "../lib/audio/AudioPlayerProvider";
import type { Meeting, Segment } from "../types/meeting";
import ExportMenu from "../components/export/ExportMenu";
import SeriesPicker from "../components/series/SeriesPicker";
import SinceLastTimeList from "../components/series/SinceLastTimeList";
import type { MeetingAccountFields, SinceLastTime } from "../types/account";
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
    setData: setMeeting,
  } = useFetch<Meeting>(`/meetings/${id}`);

  const { data: segments, setData: setSegments } = useFetch<Segment[]>(
    `/meetings/${id}/segments`
  );

  // Processing runs as durable background jobs: follow it
  // over SSE while a stage is active, then re-read the meeting quietly
  // (no skeleton) once it settles.
  const active =
    meeting != null &&
    (isActiveStage(meeting.processingStage) || meeting.status === "PROCESSING");

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const [next, nextSegments] = await Promise.all([
        getData<Meeting>(`/meetings/${id}`),
        getData<Segment[]>(`/meetings/${id}/segments`),
      ]);
      setMeeting(next);
      setSegments(nextSegments);
    } catch (err) {
      console.error(err);
    }
  }, [id, setMeeting, setSegments]);

  const { progress } = useMeetingProgress(id, {
    enabled: active,
    onSettled: () => void reload(),
  });

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
  const [retrying, setRetrying] = useState(false);

  /**
   * Lets the user recover a meeting whose pipeline failed midway: one
   * POST /retry (202) resumes from the right step (from CLEAN when the
   * transcript exists, else a fresh transcription).
   */
  const retry = async () => {
    if (!id || !meeting) return;
    setRetryError(null);
    setRetrying(true);

    try {
      const state = await retryProcessing(id);
      setMeeting({
        ...meeting,
        status: state.status,
        processingStage: state.processingStage,
        processingError: null,
      });
    } catch (err) {
      console.error(err);
      setRetryError(getErrorMessage(err));
    } finally {
      setRetrying(false);
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

  // The live row from the stream wins while a run is being followed.
  const stage = (active && progress?.processingStage) || meeting.processingStage;
  const processingError = active && progress ? progress.processingError : meeting.processingError;
  const running = active && (progress == null || isActiveStage(progress.processingStage));
  const isProcessing = running || meeting.status === "LIVE";
  const hasFailed = meeting.status === "FAILED" || stage === "FAILED";
  // A live capture with no speech has nothing to summarize or retry.
  const noSpeech = meeting.processingStage === "NO_SPEECH";
  const incomplete = !noSpeech && (hasFailed || !meeting.summary);

  const duration = formatDuration(meeting.durationSec);
  // Series link, retention and "Since last time".
  const account = meeting as Meeting & MeetingAccountFields;
  const since = (meeting.summary?.data as { sinceLastTime?: SinceLastTime } | null | undefined)?.sinceLastTime;

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

      <div className="acct-row" style={{ marginBottom: 12 }}>
        <SeriesPicker
          meetingId={meeting.id}
          seriesId={account.seriesId ?? null}
          onChange={(seriesId) => setMeeting({ ...account, seriesId } as Meeting)}
        />
      </div>

      {account.audioDeletedAt && !meeting.audioPath && (
        <p className="muted tiny" role="status">
          The recording was deleted on {formatDate(account.audioDeletedAt)} (your audio retention setting). The
          transcript and summary are kept.
        </p>
      )}

      {meeting.audioPath && (
        <AudioPlayer src={`${API_BASE_URL}/meetings/${meeting.id}/audio`} />
      )}

      {retryError && (
        <div role="alert" className="alert">
          {retryError}
        </div>
      )}

      {processingError && !running && (
        <p className="muted tiny" role="status">
          {failureMessage(processingError)}
        </p>
      )}

      {running && (
        <div className="card" role="status">
          <ProgressSteps
            stage={stage}
            before={
              // The live final pass first joins the chunks into one recording.
              meeting.source === "LIVE"
                ? [{ label: "Assembling the recording", done: stage !== "ASSEMBLING" }]
                : []
            }
          />
          <p className="muted tiny" style={{ marginBottom: 0 }}>
            This can take a few minutes; the page updates by itself.
          </p>
        </div>
      )}

      {meeting.status === "LIVE" && !running && (
        <div className="card">
          <p>This meeting is being captured right now.</p>
          <button
            type="button"
            className="secondary"
            onClick={() => void refetch()}
          >
            Refresh
          </button>
        </div>
      )}

      {hasFailed && !running && (
        <div className="card">
          <ProgressSteps
            stage={failedStage(meeting.processingError)}
            failed
          />
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

      {incomplete && !isProcessing && (
        <div className="card">
          <p>
            {hasFailed
              ? "Processing did not finish for this meeting."
              : "This meeting has no summary yet."}
          </p>

          <button type="button" disabled={retrying} onClick={() => void retry()}>
            {retrying
              ? "Starting..."
              : meeting.transcript
                ? "Generate summary"
                : "Retry processing"}
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
          {since && since.items.length > 0 && (
            <section className="card" style={{ marginBottom: 16 }}>
              <h2>Since last time</h2>
              <SinceLastTimeList meetingId={meeting.id} data={since} />
            </section>
          )}

          {meeting.summary && <div style={{ marginBottom: 16 }}><ExportMenu meetingId={meeting.id} /></div>}

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
