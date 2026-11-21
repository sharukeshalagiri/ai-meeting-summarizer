import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getErrorMessage, postData } from "../api/api";
import { retryProcessing, startProcessing } from "../api/processing";
import ProgressSteps from "../components/progress/ProgressSteps";
import {
  failedStage,
  failureMessage,
  isActiveStage,
  isFailed,
} from "../components/progress/stages";
import { useMeetingProgress } from "../components/progress/useMeetingProgress";
import type { Meeting } from "../types/meeting";
import type { MeetingProgress } from "../types/processing";

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * - upload: creating the meeting and sending the file (real progress)
 * - processing: the pipeline runs as background jobs (POST /process
 *   answers 202) and the page follows it over SSE
 * - failed: queueing or a job failed; the meeting is kept, retry resumes
 */
type Phase = "idle" | "upload" | "processing" | "failed";

function NewMeeting() {
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [queuedStage, setQueuedStage] = useState<string | null>(null);

  const onSettled = useCallback(
    (row: MeetingProgress) => {
      if (isFailed(row)) {
        setPhase("failed");
        setError(failureMessage(row.processingError) ?? "Processing failed.");
        return;
      }

      navigate(`/meeting/${row.id}`);
    },
    [navigate]
  );

  const { progress } = useMeetingProgress(meetingId ?? undefined, {
    enabled: phase === "processing",
    onSettled,
  });

  const busy = phase === "upload" || phase === "processing";

  /** Queues (or re-queues) the pipeline; the hook follows it from there. */
  const queue = async (id: string, run: typeof startProcessing) => {
    try {
      const state = await run(id);
      setQueuedStage(state.processingStage);
      setError(null);
      setPhase("processing");
    } catch (err) {
      console.error(err);
      setError(getErrorMessage(err));
      setPhase("failed");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      setError("Please choose an audio or video file.");
      return;
    }

    setError(null);
    setUploadPercent(0);
    setPhase("upload");

    let id: string;

    try {
      const meeting = await postData<Meeting>("/meetings", {
        title,
        description,
      });
      id = meeting.id;
      setMeetingId(id);

      // Upload only, so progress is real; the processing is queued next.
      const formData = new FormData();
      formData.append("audio", file);

      await postData<Meeting>(`/meetings/${id}/audio`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: TEN_MINUTES,
        onUploadProgress: (event: { loaded: number; total?: number }) => {
          if (event.total) {
            setUploadPercent(Math.round((event.loaded * 100) / event.total));
          }
        },
      });
    } catch (err) {
      console.error(err);
      setError(getErrorMessage(err));
      setPhase("idle");
      return;
    }

    await queue(id, startProcessing);
  };

  const stage =
    phase === "failed"
      ? failedStage(progress?.processingError) ?? progress?.processingStage ?? queuedStage
      : // Until the new run reports, the last row may still be the old failure.
        (isActiveStage(progress?.processingStage) ? progress?.processingStage : null) ??
        queuedStage;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Upload a recording</h1>
          <p className="muted">
            Audio or video. It is transcribed, speakers are attributed,
            and the meeting is summarized automatically.
          </p>
        </div>
      </header>

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="title">Meeting title</label>
          <input
            id="title"
            type="text"
            placeholder="Weekly standup"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            disabled={busy || phase === "failed"}
          />
        </div>

        <div className="field">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            placeholder="Optional context for this meeting"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy || phase === "failed"}
          />
        </div>

        <div className="field">
          <label htmlFor="audio">Audio or video file</label>
          <input
            id="audio"
            type="file"
            accept=".mp3,.wav,.ogg,.m4a,.flac,.mp4,.mov,.mkv,.webm,.avi"
            disabled={busy || phase === "failed"}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setError(null);
            }}
          />
          {file && (
            <p className="muted" style={{ marginTop: 8 }}>
              {file.name} ({(file.size / (1024 * 1024)).toFixed(1)} MB)
            </p>
          )}
        </div>

        {error && (
          <div role="alert" className="alert" style={{ whiteSpace: "pre-line" }}>
            {error}
          </div>
        )}

        <div className="actions">
          {phase === "failed" && meetingId ? (
            <>
              <button type="button" onClick={() => void queue(meetingId, retryProcessing)}>
                Retry processing
              </button>
              <Link to={`/meeting/${meetingId}`}>
                <button type="button" className="secondary">
                  Open the meeting
                </button>
              </Link>
            </>
          ) : (
            <>
              <button type="submit" disabled={busy}>
                {busy ? "Processing..." : "Upload Meeting"}
              </button>

              <button
                type="button"
                className="secondary"
                onClick={() => navigate("/")}
                disabled={phase === "upload"}
              >
                Cancel
              </button>
            </>
          )}
        </div>

        {phase !== "idle" && (
          <div className="card" style={{ marginTop: 20 }}>
            <ProgressSteps
              stage={phase === "upload" ? null : stage}
              failed={phase === "failed"}
              before={[
                {
                  label: "Uploading",
                  done: phase !== "upload",
                  detail: uploadPercent > 0 ? `${uploadPercent}%` : undefined,
                },
              ]}
            />

            {phase === "upload" && (
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
            )}

            {phase === "processing" && meetingId && (
              <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
                Processing runs in the background and survives a server
                restart, so you can leave this page.{" "}
                <Link to={`/meeting/${meetingId}`}>Open the meeting</Link>{" "}
                to follow it there.
              </p>
            )}
          </div>
        )}
      </form>
    </div>
  );
}

export default NewMeeting;
