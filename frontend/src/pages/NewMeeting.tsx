import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getErrorMessage, postData } from "../api/api";
import type { Meeting, Summary, Transcript } from "../types/meeting";

/** Stages run in this order; the UI marks earlier ones done. */
const STAGES = [
  { key: "upload", label: "Uploading" },
  { key: "transcribe", label: "Transcribing" },
  { key: "summarize", label: "Generating Summary" },
  { key: "done", label: "Done" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

const TEN_MINUTES = 10 * 60 * 1000;

function NewMeeting() {
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<StageKey | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loading = stage !== null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      setError("Please choose an audio or video file.");
      return;
    }

    setError(null);
    setUploadPercent(0);

    let meetingId: string | null = null;

    try {
      // STEP 1 — create the meeting record
      setStage("upload");

      const meeting = await postData<Meeting>("/meetings", {
        title,
        description,
      });

      meetingId = meeting.id;

      // STEP 2 — upload the file only, so progress is real
      const formData = new FormData();
      formData.append("audio", file);

      await postData<Meeting>(
        `/meetings/${meeting.id}/audio`,
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: TEN_MINUTES,
          onUploadProgress: (event: {
            loaded: number;
            total?: number;
          }) => {
            if (event.total) {
              setUploadPercent(
                Math.round((event.loaded * 100) / event.total)
              );
            }
          },
        }
      );

      // STEP 3 — transcribe (Whisper)
      setStage("transcribe");

      await postData<Transcript>(
        `/meetings/${meeting.id}/transcribe`,
        undefined,
        { timeout: 15 * 60 * 1000 }
      );

      // STEP 4 — summarize (Gemini)
      setStage("summarize");

      await postData<Summary>(
        `/meetings/${meeting.id}/summarize`,
        undefined,
        { timeout: TEN_MINUTES }
      );

      setStage("done");

      navigate(`/meeting/${meeting.id}`);
    } catch (err) {
      console.error(err);

      setError(getErrorMessage(err));
      setStage(null);

      // The meeting exists but did not finish; let the user pick up
      // from its detail page rather than losing the upload.
      if (meetingId) {
        setError(
          (current) =>
            `${current ?? ""}\n\nThe meeting was saved. You can open ` +
            `it from the dashboard and retry.`
        );
      }
    }
  };

  const currentIndex = stage
    ? STAGES.findIndex((s) => s.key === stage)
    : -1;

  return (
    <div className="page">
      <h1>Create Meeting</h1>

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
            disabled={loading}
          />
        </div>

        <div className="field">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            placeholder="Optional context for this meeting"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="field">
          <label htmlFor="audio">Audio or video file</label>
          <input
            id="audio"
            type="file"
            accept=".mp3,.wav,.ogg,.m4a,.flac,.mp4,.mov,.mkv,.webm,.avi"
            disabled={loading}
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
          <button type="submit" disabled={loading}>
            {loading ? "Processing..." : "Upload Meeting"}
          </button>

          <button
            type="button"
            className="secondary"
            onClick={() => navigate("/")}
            disabled={loading}
          >
            Cancel
          </button>
        </div>

        {loading && (
          <div className="card" style={{ marginTop: 20 }}>
            <ol className="steps">
              {STAGES.map((s, index) => {
                const done = index < currentIndex;
                const active = index === currentIndex;

                return (
                  <li
                    key={s.key}
                    className={`step ${done ? "step-done" : ""} ${
                      active ? "step-active" : ""
                    }`}
                  >
                    <span className="step-icon">
                      {done ? (
                        "✓"
                      ) : active && s.key !== "done" ? (
                        <span className="spinner" />
                      ) : active ? (
                        "✓"
                      ) : (
                        "○"
                      )}
                    </span>

                    <span>
                      {s.label}
                      {active &&
                        s.key === "upload" &&
                        uploadPercent > 0 &&
                        ` ${uploadPercent}%`}
                    </span>
                  </li>
                );
              })}
            </ol>

            {stage === "upload" && (
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
            )}

            <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
              Transcribing a long recording can take a few minutes.
              Please keep this tab open.
            </p>
          </div>
        )}
      </form>
    </div>
  );
}

export default NewMeeting;
