import { Link } from "react-router-dom";
import type { Meeting, StructuredSummary } from "../types/meeting";
import { formatDate, formatDuration } from "../utils/format";
import StatusBadge from "./StatusBadge";
import { readSummaryV2 } from "./summary/summaryData";

interface Props {
  meeting: Meeting;
}

const PLATFORM_LABEL: Record<string, string> = {
  GOOGLE_MEET: "Google Meet",
  ZOOM: "Zoom",
  MICROSOFT_TEAMS: "Teams",
  OTHER: "Browser",
};

/**
 * What the card shows from a summary, for both stored schema versions:
 * v1 (StructuredSummary) and v2 (schemaVersion 2, the pipeline since
 * Pair 1). Reading v1 fields off a v2 summary threw and blanked the list.
 */
const glance = (data: unknown) => {
  const v2 = readSummaryV2(data);
  if (v2) {
    return {
      excerpt: v2.tldr,
      decisions: v2.decisions.length,
      blockers: (v2.sections.project?.people ?? []).reduce(
        (sum, person) => sum + person.blockers.length,
        0
      ),
    };
  }

  const v1 = (data ?? null) as Partial<StructuredSummary> | null;
  if (!v1) return null;
  return {
    excerpt: v1.executiveSummary ?? "",
    decisions: v1.keyDecisions?.length ?? 0,
    blockers: v1.blockers?.length ?? 0,
  };
};

function MeetingCard({ meeting }: Props) {
  const summary = glance(meeting.summary?.data);
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

        <StatusBadge
          status={meeting.status}
          stage={meeting.processingStage}
        />
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
      {summary?.excerpt ? (
        <p className="card-excerpt">{summary.excerpt}</p>
      ) : (
        meeting.description && (
          <p className="card-excerpt">{meeting.description}</p>
        )
      )}

      {summary && (
        <div className="card-facts">
          {summary.decisions > 0 && (
            <span className="chip">
              {summary.decisions} decision
              {summary.decisions === 1 ? "" : "s"}
            </span>
          )}

          {openTasks > 0 && <span className="chip">{openTasks} open</span>}

          {summary.blockers > 0 && (
            <span className="chip tone-critical">
              {summary.blockers} blocker
              {summary.blockers === 1 ? "" : "s"}
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
