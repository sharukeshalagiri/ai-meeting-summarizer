import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getErrorMessage } from "../api/api";
import { createSeries } from "../api/w4-acct";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { Skeleton } from "../components/Skeleton";
import SinceLastTimeList from "../components/series/SinceLastTimeList";
import { useFetch } from "../hooks/useFetch";
import type { Prep as PrepData, SeriesSummary } from "../types/w4-acct";
import { formatDate } from "../utils/format";
import "../components/account/account.css";

/**
 * Prep: what to read before the next meeting of a series. Without a
 * series id it lists the series; with one it gathers the open tasks
 * across the series and the latest meeting's decisions, open questions
 * and "prepare for next time".
 */
function Prep() {
  const { seriesId } = useParams();
  return seriesId ? <SeriesPrep seriesId={seriesId} /> : <SeriesIndex />;
}

function SeriesIndex() {
  const { data, loading, error, refetch } = useFetch<SeriesSummary[]>("/series");
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const navigate = useNavigate();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError(null);
    try {
      const series = await createSeries(name);
      navigate(`/prep/${series.id}`);
    } catch (err) {
      setCreateError(getErrorMessage(err));
    }
  };

  return (
    <div className="page acct">
      <header className="page-header">
        <div>
          <h1>Prep</h1>
          <p className="muted">Recurring meetings, and what is still open in each.</p>
        </div>
      </header>

      {loading && <Skeleton rows={2} />}
      {error && <ErrorState message={error} onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          title="No series yet"
          body="Link a meeting to a series from its page (e.g. 'Weekly 1:1'), or create one here."
        />
      )}

      {data && data.length > 0 && (
        <ul className="series-list">
          {data.map((series) => (
            <li key={series.id} className="card">
              <Link to={`/prep/${series.id}`}>
                <strong>{series.name}</strong>
              </Link>
              <p className="muted tiny" style={{ margin: "4px 0 0" }}>
                {series.meetingCount} meeting{series.meetingCount === 1 ? "" : "s"}
                {series.lastMeeting && ` · last: ${series.lastMeeting.title}, ${formatDate(series.lastMeeting.createdAt)}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      <form className="card acct-row" style={{ marginTop: 16 }} onSubmit={(event) => void create(event)}>
        <div style={{ flex: "1 1 240px" }}>
          <label htmlFor="series-name">New series</label>
          <input id="series-name" type="text" placeholder="Weekly 1:1 with Priya" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </div>
        <button type="submit">Create</button>
        {createError && (
          <div role="alert" className="alert" style={{ flexBasis: "100%" }}>
            {createError}
          </div>
        )}
      </form>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="card">
      <h2>{title}</h2>
      <ul className="tight-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function SeriesPrep({ seriesId }: { seriesId: string }) {
  const { data, loading, error, refetch } = useFetch<PrepData>(`/series/${seriesId}/prep`);

  if (loading) return <div className="page"><Skeleton rows={3} /></div>;
  if (error || !data) {
    return (
      <div className="page">
        <ErrorState message={error ?? "Series not found."} onRetry={() => void refetch()} />
      </div>
    );
  }

  const latest = data.latest;

  return (
    <div className="page acct">
      <p>
        <Link to="/prep" className="back-link">&larr; All series</Link>
      </p>
      <header className="page-header">
        <div>
          <h1>{data.series.name}</h1>
          <p className="muted">
            {data.meetings.length} meeting{data.meetings.length === 1 ? "" : "s"}
            {latest && <> · last: <Link to={`/meeting/${latest.id}`}>{latest.title}</Link>, {formatDate(latest.createdAt)}</>}
          </p>
        </div>
        <div className="actions">
          <Link to={`/ask?seriesId=${data.series.id}`}>
            <button type="button" className="secondary sm">Ask about this series</button>
          </Link>
        </div>
      </header>

      <div className="stack">
        <section className="card">
          <h2>Still open ({data.openItems.length})</h2>
          {data.openItems.length === 0 && <p className="muted">Nothing open in this series.</p>}
          <ul className="tight-list">
            {data.openItems.map((item) => (
              <li key={item.id}>
                {item.task}
                <span className="muted tiny">
                  {" "}
                  · {item.owner ?? "no owner"}
                  {(item.dueSpoken || item.dueDate) && ` · due ${item.dueSpoken ?? item.dueDate}`} ·{" "}
                  <Link to={`/meeting/${item.meeting.id}`}>{item.meeting.title}</Link>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {latest?.sinceLastTime && (
          <section className="card">
            <h2>Last time, compared with before</h2>
            <SinceLastTimeList meetingId={latest.id} data={latest.sinceLastTime} readOnly />
          </section>
        )}

        {latest?.tldr && (
          <section className="card">
            <h2>Last meeting in brief</h2>
            <p>{latest.tldr}</p>
          </section>
        )}
        <List title="Prepare for next time" items={latest?.nextSessionPrep ?? []} />
        <List title="Open questions" items={latest?.openQuestions ?? []} />
        <List title="Decisions so far (last meeting)" items={latest?.decisions ?? []} />

        <section className="card">
          <h2>Meetings</h2>
          <ul className="tight-list">
            {[...data.meetings].reverse().map((meeting) => (
              <li key={meeting.id}>
                <Link to={`/meeting/${meeting.id}`}>{meeting.title}</Link>{" "}
                <span className="muted tiny">{formatDate(meeting.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

export default Prep;
