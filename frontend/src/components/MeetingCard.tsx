import { Link } from "react-router-dom";
import type { Meeting } from "../types/meeting";
import StatusBadge from "./StatusBadge";

interface Props {
  meeting: Meeting;
}

function MeetingCard({ meeting }: Props) {
  return (
    <div className="card">
      <div className="header-row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{meeting.title}</h2>

        <StatusBadge status={meeting.status} />
      </div>

      {meeting.description && <p>{meeting.description}</p>}

      <p className="muted">
        Transcript: {meeting.transcript ? "ready" : "not yet"} &middot;{" "}
        Summary: {meeting.summary ? "ready" : "not yet"}
      </p>

      <div className="actions">
        <Link to={`/meeting/${meeting.id}`}>
          <button className="secondary">Open Meeting</button>
        </Link>
      </div>
    </div>
  );
}

export default MeetingCard;
