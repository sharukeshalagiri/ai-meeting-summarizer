import { Link } from "react-router-dom";
import MeetingCard from "../components/MeetingCard";
import { useFetch } from "../hooks/useFetch";
import type { Meeting } from "../types/meeting";

function Dashboard() {
  const {
    data: meetings,
    loading,
    error,
    refetch,
  } = useFetch<Meeting[]>("/meetings");

  return (
    <div className="page">
      <div className="header-row">
        <h1 style={{ margin: 0 }}>AI Meeting Summarizer</h1>

        <div className="actions">
          <Link to="/new">
            <button>+ New Meeting</button>
          </Link>
        </div>
      </div>

      {loading && <p className="muted">Loading meetings...</p>}

      {!loading && error && (
        <div>
          <div role="alert" className="alert">
            {error}
          </div>

          <button className="secondary" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && meetings && (
        <>
          <p className="muted">
            {meetings.length === 1
              ? "1 meeting"
              : `${meetings.length} meetings`}
          </p>

          {meetings.length === 0 ? (
            <div className="card">
              <p style={{ marginBottom: 0 }}>
                No meetings yet. Upload a recording to get started.
              </p>
            </div>
          ) : (
            meetings.map((meeting) => (
              <MeetingCard key={meeting.id} meeting={meeting} />
            ))
          )}
        </>
      )}
    </div>
  );
}

export default Dashboard;
