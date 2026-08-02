import { Link } from "react-router-dom";
import type { Meeting } from "../types/meeting";
import { formatDate, formatDuration } from "../utils/format";
import StatusBadge from "./StatusBadge";

interface Props {
  meeting: Meeting;
}

const PLATFORM_LABEL: Record<string, string> = {
  GOOGLE_MEET: "Google Meet",
  ZOOM: "Zoom",
  MICROSOFT_TEAMS: "Teams",
  OTHER: "Browser",
};

function MeetingCard({ meeting }: Props) {
  const summary = meeting.summary?.data;
  const duration = formatDuration(meeting.durationSec);

  const openTasks =
    meeting.actionItems?.filter((item) => item.status === "PENDING")
      .length ?? 0;

  return (
    <article className="card meeting-card">
      <div className="meeting-card-head">
        <h2>
          <Link to={`/meeting/${meeting.id}`} className="card-link">
            {meeting.title}
          </Link>
        </h2>

        <StatusBadge status={meeting.status} />
      </div>

      <p className="muted tiny meta-row">
        <span>{formatDate(meeting.createdAt)}</span>

        {duration && <span>{duration}</span>}

        {meeting.source === "LIVE" && (
          <span>
            {PLATFORM_LABEL[meeting.platform ?? "OTHER"] ?? "Live"}
          </span>
        )}
      </p>

      {/* The executive summary is far more useful at a glance than the
          description the user typed, so it wins when present. */}
      {summary ? (
        <p className="card-excerpt">{summary.executiveSummary}</p>
      ) : (
        meeting.description && (
          <p className="card-excerpt">{meeting.description}</p>
        )
      )}

      {summary && (
        <div className="card-facts">
          {summary.keyDecisions.length > 0 && (
            <span className="chip">
              {summary.keyDecisions.length} decision
              {summary.keyDecisions.length === 1 ? "" : "s"}
            </span>
          )}

          {openTasks > 0 && <span className="chip">{openTasks} open</span>}

          {summary.blockers.length > 0 && (
            <span className="chip tone-critical">
              {summary.blockers.length} blocker
              {summary.blockers.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}

      {!summary && !meeting.description && (
        <p className="muted tiny">
          {meeting.transcript
            ? "Transcribed, not yet summarized."
            : "Not processed yet."}
        </p>
      )}
    </article>
  );
}

export default MeetingCard;
