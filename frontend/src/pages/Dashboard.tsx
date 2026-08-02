import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import MeetingCard from "../components/MeetingCard";
import { Skeleton } from "../components/Skeleton";
import { useFetch } from "../hooks/useFetch";
import type { Meeting } from "../types/meeting";

function Dashboard() {
  const {
    data: meetings,
    loading,
    error,
    refetch,
  } = useFetch<Meeting[]>("/meetings");

  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!meetings) return [];

    const needle = query.trim().toLowerCase();

    if (!needle) return meetings;

    // Title and description only. Searching transcript *content* is
    // what /ask is for, and doing it here would mean matching text the
    // card never shows.
    return meetings.filter(
      (meeting) =>
        meeting.title.toLowerCase().includes(needle) ||
        meeting.description?.toLowerCase().includes(needle)
    );
  }, [meetings, query]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Meetings</h1>
          <p className="muted">
            Every recording and live capture, summarized and searchable.
          </p>
        </div>

        <div className="actions">
          <Link to="/live">
            <button type="button" className="secondary">
              Go live
            </button>
          </Link>

          <Link to="/new">
            <button type="button">Upload recording</button>
          </Link>
        </div>
      </header>

      {loading && <Skeleton rows={3} />}

      {!loading && error && (
        <ErrorState message={error} onRetry={() => void refetch()} />
      )}

      {!loading && !error && meetings && (
        <>
          {meetings.length === 0 ? (
            <EmptyState
              title="No meetings yet"
              body="Upload a recording, or capture a Google Meet, Zoom, or Teams call straight from your browser."
              action={
                <>
                  <Link to="/new">
                    <button type="button">Upload a recording</button>
                  </Link>
                  <Link to="/live">
                    <button type="button" className="secondary">
                      Start a live meeting
                    </button>
                  </Link>
                </>
              }
            />
          ) : (
            <>
              <div className="list-toolbar">
                <div className="field inline">
                  <label htmlFor="meeting-search" className="sr-only">
                    Search meetings
                  </label>
                  <input
                    id="meeting-search"
                    type="search"
                    placeholder="Search meetings"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>

                <p className="muted tiny">
                  {filtered.length}
                  {query ? ` of ${meetings.length}` : ""} meeting
                  {filtered.length === 1 ? "" : "s"}
                </p>
              </div>

              {filtered.length === 0 ? (
                <EmptyState
                  title="No matches"
                  body={`Nothing matches "${query}". Try the Ask AI page to search inside transcripts.`}
                  action={
                    <Link to="/ask">
                      <button type="button" className="secondary">
                        Ask AI
                      </button>
                    </Link>
                  }
                />
              ) : (
                <div className="meeting-grid">
                  {filtered.map((meeting) => (
                    <MeetingCard key={meeting.id} meeting={meeting} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default Dashboard;
