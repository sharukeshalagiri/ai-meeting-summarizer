interface Props {
  status: string;
}

/** Shared so the dashboard and detail page label statuses identically. */
function StatusBadge({ status }: Props) {
  const tone =
    status === "COMPLETED"
      ? "badge-ok"
      : status === "FAILED"
        ? "badge-error"
        : status === "PROCESSING"
          ? "badge-busy"
          : "";

  const label =
    status === "COMPLETED"
      ? "Completed"
      : status === "FAILED"
        ? "Failed"
        : status === "PROCESSING"
          ? "Processing"
          : status === "TRANSCRIBED"
            ? "Transcribed"
            : "Created";

  return <span className={`badge ${tone}`}>{label}</span>;
}

export default StatusBadge;
