interface Props {
  status: string;
}

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

function StatusBadge({ status }: Props) {
  const entry = STATUS[status] ?? { label: status, tone: "" };

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
