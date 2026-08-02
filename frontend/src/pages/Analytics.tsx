import { useState } from "react";
import { Link } from "react-router-dom";
import BarList from "../components/charts/BarList";
import StatTile from "../components/charts/StatTile";
import TrendChart from "../components/charts/TrendChart";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { Skeleton } from "../components/Skeleton";
import { useFetch } from "../hooks/useFetch";
import type { Analytics as AnalyticsData } from "../types/meeting";
import { formatDuration, formatMinutes } from "../utils/format";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** Sentiment is a state, so it gets the reserved status colors. */
const SENTIMENT_TONE: Record<string, string> = {
  POSITIVE: "tone-good",
  NEUTRAL: "tone-neutral",
  MIXED: "tone-warning",
  NEGATIVE: "tone-critical",
};


function Analytics() {
  const [days, setDays] = useState(30);

  const { data, loading, error, refetch } = useFetch<AnalyticsData>(
    `/analytics?days=${days}`
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Analytics</h1>
          <p className="muted">
            How your meetings are trending across the workspace.
          </p>
        </div>

        <div
          className="segmented"
          role="group"
          aria-label="Time range"
        >
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              className={`segment ${days === range.days ? "is-active" : ""}`}
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </header>

      {loading && <Skeleton rows={4} />}

      {!loading && error && (
        <ErrorState message={error} onRetry={() => void refetch()} />
      )}

      {!loading && !error && data && (
        <>
          {data.totals.meetings === 0 ? (
            <EmptyState
              title="No meetings yet"
              body="Upload a recording or capture a live meeting, and your analytics will appear here."
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
              <section
                className="stat-grid"
                aria-label="Key figures"
              >
                <StatTile
                  label="Meetings"
                  value={data.totals.meetings}
                  hint={`${data.totals.decisions} decisions recorded`}
                />

                <StatTile
                  label="Total time"
                  value={
                    // Seconds, not the pre-rounded minutes: a handful
                    // of short meetings would otherwise total "0m".
                    formatDuration(data.totals.totalDurationSec) ??
                    formatMinutes(0)
                  }
                  hint={`Average ${
                    formatDuration(data.totals.avgDurationSec) ?? "0m"
                  } per meeting`}
                />

                <StatTile
                  label="Action items"
                  value={data.totals.actionItems}
                  hint={`${data.totals.pendingActionItems} still open`}
                />

                <StatTile
                  label="Completed"
                  value={`${data.totals.completionRate}%`}
                  meter={data.totals.completionRate / 100}
                  hint={`${data.totals.completedActionItems} of ${data.totals.actionItems} done`}
                />
              </section>

              <section className="card">
                <h2>Meeting frequency</h2>
                <p className="muted tiny">
                  Meetings started each day over the last {days} days.
                </p>

                <TrendChart
                  data={data.frequency}
                  empty="No meetings in this range."
                />
              </section>

              <div className="grid-2">
                <section className="card">
                  <h2>Keywords</h2>
                  <p className="muted tiny">
                    Terms appearing most across your meetings.
                  </p>

                  <BarList
                    data={data.keywordTrends}
                    empty="Keywords appear once meetings have been summarized."
                  />
                </section>

                <section className="card">
                  <h2>Discussion topics</h2>
                  <p className="muted tiny">
                    What your meetings keep coming back to.
                  </p>

                  <BarList
                    data={data.topicTrends}
                    empty="Topics appear once meetings have been summarized."
                  />
                </section>
              </div>

              <div className="grid-2">
                <section className="card">
                  <h2>Sentiment</h2>
                  <p className="muted tiny">
                    Overall tone across summarized meetings.
                  </p>

                  {data.sentimentBreakdown.length === 0 ? (
                    <p className="muted">
                      Sentiment appears once meetings have been
                      summarized.
                    </p>
                  ) : (
                    <ul className="sentiment-list">
                      {data.sentimentBreakdown.map((entry) => (
                        <li key={entry.label}>
                          <span
                            className={`dot ${
                              SENTIMENT_TONE[entry.label] ??
                              "tone-neutral"
                            }`}
                            aria-hidden="true"
                          />
                          <span className="sentiment-label">
                            {entry.label.charAt(0) +
                              entry.label.slice(1).toLowerCase()}
                          </span>
                          <span className="sentiment-count">
                            {entry.count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="card">
                  <h2>Open work by owner</h2>
                  <p className="muted tiny">
                    Who is carrying the most outstanding tasks.
                  </p>

                  <BarList
                    data={data.workload}
                    empty="No open action items have an owner yet."
                    unit="task"
                  />
                </section>
              </div>

              <section className="card">
                <h2>Risks &amp; blockers</h2>

                <div className="mini-stats">
                  <div>
                    <span className="mini-value">
                      {data.totals.risks}
                    </span>
                    <span className="muted tiny">Risks raised</span>
                  </div>
                  <div>
                    <span className="mini-value">
                      {data.totals.blockers}
                    </span>
                    <span className="muted tiny">Blockers</span>
                  </div>
                  <div>
                    <span className="mini-value">
                      {data.totals.openQuestions}
                    </span>
                    <span className="muted tiny">Open questions</span>
                  </div>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default Analytics;
