import { useState } from "react";
import { Link } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { Skeleton } from "../components/Skeleton";
import { getErrorMessage, patchData } from "../api/api";
import { useFetch } from "../hooks/useFetch";
import {
  formatDue,
  isOverdue,
  sortByDue,
} from "../components/summary/summaryData";
import "../components/summary/summary.css";
import type { ActionItemRecord } from "../types/meeting";
import type { ActionItemRow } from "../types/w1-sum";

/** v2 rows carry dueSpoken / needsReview; v1 rows simply lack them. */
type TaskRecord = ActionItemRecord & Partial<ActionItemRow>;

const FILTERS = [
  { value: "", label: "All" },
  { value: "PENDING", label: "Open" },
  { value: "COMPLETED", label: "Done" },
];

const PRIORITY_TONE: Record<string, string> = {
  HIGH: "tone-critical",
  MEDIUM: "tone-warning",
  LOW: "tone-neutral",
};

/**
 * Action items across every meeting.
 *
 * These live in their own table rather than inside each summary, so
 * they can be tracked once and counted across meetings.
 */
function Tasks() {
  const [filter, setFilter] = useState("");

  const { data, loading, error, refetch, setData } = useFetch<
    TaskRecord[]
  >(`/action-items${filter ? `?status=${filter}` : ""}`);

  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const toggle = async (item: TaskRecord) => {
    const next =
      item.status === "COMPLETED" ? "PENDING" : "COMPLETED";

    setSaving(item.id);
    setSaveError(null);

    try {
      await patchData<ActionItemRecord>(`/action-items/${item.id}`, {
        status: next,
      });

      // Update in place rather than refetching: the row is already on
      // screen and a full reload would lose the scroll position.
      if (data) {
        setData(
          filter && filter !== next
            ? data.filter((row) => row.id !== item.id)
            : sortByDue(
                data.map((row) =>
                  row.id === item.id ? { ...row, status: next } : row
                )
              )
        );
      }
    } catch (err) {
      console.error(err);
      setSaveError(getErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Action items</h1>
          <p className="muted">
            Everything your meetings committed someone to.
          </p>
        </div>

        <div className="segmented" role="group" aria-label="Filter">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`segment ${filter === option.value ? "is-active" : ""}`}
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {saveError && (
        <div role="alert" className="alert">
          {saveError}
        </div>
      )}

      {loading && <Skeleton rows={3} />}

      {!loading && error && (
        <ErrorState message={error} onRetry={() => void refetch()} />
      )}

      {!loading && !error && data && (
        <>
          {data.length === 0 ? (
            <EmptyState
              title={
                filter === "COMPLETED"
                  ? "Nothing completed yet"
                  : filter === "PENDING"
                    ? "No open tasks"
                    : "No action items yet"
              }
              body="Action items are extracted automatically when a meeting is summarized."
              action={
                <Link to="/new">
                  <button type="button">Upload a recording</button>
                </Link>
              }
            />
          ) : (
            <ul className="task-list">
              {sortByDue(data).map((item) => {
                const done = item.status === "COMPLETED";
                const overdue = !done && isOverdue(item.dueDate);
                const due = item.dueSpoken ?? item.dueDate;

                return (
                  <li
                    key={item.id}
                    className={`task-row ${done ? "is-done" : ""}`}
                  >
                    <label className="task-check">
                      <input
                        type="checkbox"
                        checked={done}
                        disabled={saving === item.id}
                        onChange={() => void toggle(item)}
                      />
                      <span className="sr-only">
                        Mark &ldquo;{item.task}&rdquo; as{" "}
                        {done ? "open" : "complete"}
                      </span>
                    </label>

                    <div className="task-body">
                      <p className="task-text">{item.task}</p>

                      <div className="task-meta">
                        {item.owner && (
                          <span className="chip">{item.owner}</span>
                        )}

                        {due && (
                          <span
                            className="chip"
                            title={item.dueDate ?? "No calendar date"}
                          >
                            Due: {due}
                            {item.dueSpoken && item.dueDate
                              ? ` (${formatDue(item.dueDate)})`
                              : ""}
                          </span>
                        )}

                        {overdue && (
                          <span className="badge overdue-badge">Overdue</span>
                        )}

                        {item.needsReview && (
                          <span
                            className="badge review-badge"
                            title="Low confidence: confirm it in the meeting's summary"
                          >
                            Needs review
                          </span>
                        )}

                        <span
                          className={`chip ${
                            PRIORITY_TONE[item.priority] ?? ""
                          }`}
                        >
                          {item.priority.charAt(0) +
                            item.priority.slice(1).toLowerCase()}
                        </span>

                        {item.meeting && (
                          <Link
                            to={`/meeting/${item.meetingId}`}
                            className="task-source"
                          >
                            {item.meeting.title}
                          </Link>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default Tasks;
