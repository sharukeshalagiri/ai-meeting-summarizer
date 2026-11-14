interface Props {
  status: string;
  /** Meeting.processingStage; NO_SPEECH overrides the status label. */
  stage?: string | null;
}

/**
 * A live capture that ended with no speech is COMPLETED (nothing to
 * summarize), not FAILED, but "Completed" would suggest a summary.
 */
const NO_SPEECH = { label: "No speech detected", tone: "tone-neutral" };

/**
 * Status label and tone in one place, so the dashboard and detail page
 * cannot describe the same state differently.
 */
const STATUS: Record<string, { label: string; tone: string }> = {
  COMPLETED: { label: "Completed", tone: "tone-good" },
  FAILED: { label: "Failed", tone: "tone-critical" },
  PROCESSING: { label: "Processing", tone: "tone-busy" },
  LIVE: { label: "Live", tone: "tone-live" },
  TRANSCRIBED: { label: "Transcribed", tone: "tone-neutral" },
  CREATED: { label: "Created", tone: "" },
};

function StatusBadge({ status, stage }: Props) {
  const entry =
    stage === "NO_SPEECH"
      ? NO_SPEECH
      : (STATUS[status] ?? { label: status, tone: "" });

  return (
    <span className={`badge ${entry.tone}`}>
      {status === "LIVE" && (
        <span className="rec-dot sm" aria-hidden="true" />
      )}
      {entry.label}
    </span>
  );
}

export default StatusBadge;
