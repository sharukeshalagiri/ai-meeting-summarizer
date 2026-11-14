import { useState } from "react";
import { getErrorMessage } from "../../api/api";
import { reviewActionItem } from "../../api/w1-sum";
import type { Priority } from "../../types/meeting";
import type { ActionItemRow, ActionItemV2, ReviewAction } from "../../types/w1-sum";
import { SourceChips } from "./EvidenceChip";
import { formatDue, isOverdue } from "./summaryData";

const PRIORITY_TONE: Record<string, string> = {
  HIGH: "tone-critical",
  MEDIUM: "tone-warning",
  LOW: "tone-neutral",
};

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase();

interface TaskLike {
  task: string;
  owner: string | null;
  assignedBy?: string | null;
  dueSpoken?: string | null;
  dueDate: string | null;
  priority: string;
  status?: string;
}

/** Owner, requester, deadline and priority chips for one task. */
function TaskMeta({ item }: { item: TaskLike }) {
  const due = item.dueSpoken ?? item.dueDate;
  const overdue = item.status !== "COMPLETED" && isOverdue(item.dueDate);

  return (
    <span className="meta">
      {item.owner && <span className="chip chip-owner">{item.owner}</span>}
      {item.assignedBy && <span className="chip">from {item.assignedBy}</span>}
      {due && (
        <span className="chip" title={item.dueDate ?? "No calendar date"}>
          Due: {due}
          {item.dueSpoken && item.dueDate ? ` (${formatDue(item.dueDate)})` : ""}
        </span>
      )}
      {overdue && <span className="badge overdue-badge">Overdue</span>}
      <span className={`chip ${PRIORITY_TONE[item.priority] ?? ""}`}>
        {titleCase(item.priority)}
      </span>
    </span>
  );
}

function EditForm({
  row,
  busy,
  onSave,
  onCancel,
}: {
  row: ActionItemRow;
  busy: boolean;
  onSave: (changes: {
    task: string;
    owner: string | null;
    dueSpoken: string | null;
    priority: Priority;
  }) => void;
  onCancel: () => void;
}) {
  const [task, setTask] = useState(row.task);
  const [owner, setOwner] = useState(row.owner ?? "");
  const [dueSpoken, setDueSpoken] = useState(row.dueSpoken ?? row.dueDate ?? "");
  const [priority, setPriority] = useState<Priority>(
    (["HIGH", "MEDIUM", "LOW"].includes(row.priority) ? row.priority : "MEDIUM") as Priority
  );

  return (
    <form
      className="review-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          task: task.trim(),
          owner: owner.trim() || null,
          dueSpoken: dueSpoken.trim() || null,
          priority,
        });
      }}
    >
      <input aria-label="Task" value={task} onChange={(e) => setTask(e.target.value)} required />
      <input aria-label="Owner" placeholder="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
      <input
        aria-label="Deadline as spoken"
        placeholder='Deadline, e.g. "by Friday"'
        value={dueSpoken}
        onChange={(e) => setDueSpoken(e.target.value)}
      />
      <select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
        <option value="HIGH">High</option>
        <option value="MEDIUM">Medium</option>
        <option value="LOW">Low</option>
      </select>
      <span className="review-actions">
        <button type="submit" disabled={busy || !task.trim()}>
          Save
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </span>
    </form>
  );
}

interface Props {
  meetingId: string | undefined;
  /** Tracked rows (with ids) when loaded; they can be reviewed. */
  rows: ActionItemRow[] | null;
  /** The summary's own items, shown read-only until rows load. */
  fallback: ActionItemV2[];
  onRowsChange: (rows: ActionItemRow[]) => void;
}

/**
 * Action items with accept / edit / reject. Each review is stored as a
 * Correction on the server, so a later re-summarize keeps it.
 */
export function ActionItemReview({ meetingId, rows, fallback, onRowsChange }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (
    row: ActionItemRow,
    action: ReviewAction,
    changes?: Parameters<typeof reviewActionItem>[3]
  ) => {
    if (!meetingId || !rows) return;

    setBusy(row.id);
    setError(null);

    try {
      const result = await reviewActionItem(meetingId, row.id, action, changes);

      onRowsChange(
        "deleted" in result
          ? rows.filter((r) => r.id !== row.id)
          : rows.map((r) => (r.id === row.id ? { ...r, ...result } : r))
      );
      setEditing(null);
    } catch (err) {
      console.error(err);
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (!rows) {
    return (
      <ul className="action-items">
        {fallback.map((item, index) => (
          <li key={index} className="sum-item">
            <span className="sum-item-text">{item.task}</span>
            <TaskMeta item={item} />
            <SourceChips item={item} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      <ul className="action-items">
        {rows.map((row) => (
          <li key={row.id} className="sum-item">
            {editing === row.id ? (
              <EditForm
                row={row}
                busy={busy === row.id}
                onCancel={() => setEditing(null)}
                onSave={(changes) => void act(row, "edit", changes)}
              />
            ) : (
              <>
                <span className="sum-item-text">{row.task}</span>
                <TaskMeta item={row} />
                <SourceChips
                  item={{ evidence: row.evidence ?? [], needsReview: !!row.needsReview }}
                />
                <span className="review-actions">
                  {row.needsReview && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === row.id}
                      onClick={() => void act(row, "accept")}
                    >
                      Accept
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy === row.id}
                    onClick={() => setEditing(row.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy === row.id}
                    onClick={() => void act(row, "reject")}
                    aria-label={`Reject "${row.task}"`}
                  >
                    Reject
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
