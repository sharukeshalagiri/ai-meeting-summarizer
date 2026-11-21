import { useState } from "react";
import { Link } from "react-router-dom";
import { getErrorMessage } from "../../api/api";
import { resolveSinceLastTime } from "../../api/account";
import { useAudioPlayer } from "../../lib/audio/useAudioPlayer";
import type { SinceLastTime, SinceLastTimeItem } from "../../types/account";

const STATUS_LABEL: Record<SinceLastTimeItem["status"], string> = {
  done: "Done",
  still_open: "Still open",
  not_mentioned: "Not mentioned",
};

const STATUS_TONE: Record<SinceLastTimeItem["status"], string> = {
  done: "tone-good",
  still_open: "tone-warning",
  not_mentioned: "tone-neutral",
};

const time = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** An evidence chip: jumps to the segment when the page has a player. */
function Evidence({ idx, startMs, speaker, canJump }: { idx: number; startMs: number; speaker: string; canJump: boolean }) {
  const player = useAudioPlayer();
  if (!canJump) {
    return <span className="chip">{speaker} at {time(startMs)}</span>;
  }
  return (
    <button type="button" className="chip-button" onClick={() => player.jumpToSegment(idx)}>
      {speaker} at {time(startMs)}
    </button>
  );
}

/**
 * "Since last time": the earlier open tasks of the series, judged from
 * this meeting as done / still open / not mentioned. A "done" item asks
 * the user to confirm the change; nothing changes without that.
 */
function SinceLastTimeList({
  meetingId,
  data,
  readOnly = false,
}: {
  meetingId: string;
  data: SinceLastTime;
  /** Prep view: no confirm buttons, no jumping (no player there). */
  readOnly?: boolean;
}) {
  const [items, setItems] = useState(data.items);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (item: SinceLastTimeItem, action: "apply" | "dismiss") => {
    setBusy(item.actionItemId);
    setError(null);
    try {
      const result = await resolveSinceLastTime(meetingId, item.actionItemId, action);
      setItems((current) => current.map((i) => (i.actionItemId === item.actionItemId ? result.item : i)));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const visible = items.filter((item) => item.resolution !== "dismissed");
  if (visible.length === 0) return <p className="muted">Nothing from earlier meetings is waiting.</p>;

  return (
    <div>
      {visible.map((item) => (
        <div key={item.actionItemId} className="since-item">
          <div className="acct-row">
            <span className={`badge ${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
            <strong>{item.task}</strong>
          </div>
          <p className="muted tiny" style={{ margin: 0 }}>
            {item.owner ?? "No owner"}
            {item.dueSpoken && ` · due ${item.dueSpoken}`} · from{" "}
            <Link to={`/meeting/${item.fromMeeting.id}`}>{item.fromMeeting.title}</Link>
            {item.note && <> · “{item.note}”</>}
          </p>
          {item.evidence.length > 0 && (
            <div className="acct-row">
              {item.evidence.map((e) => (
                <Evidence key={e.idx} {...e} canJump={!readOnly} />
              ))}
            </div>
          )}
          {item.suggestedStatus && !item.resolution && !readOnly && (
            <div className="acct-row">
              <button type="button" className="sm" disabled={busy === item.actionItemId} onClick={() => void act(item, "apply")}>
                Mark as done
              </button>
              <button type="button" className="secondary sm" disabled={busy === item.actionItemId} onClick={() => void act(item, "dismiss")}>
                Keep open
              </button>
            </div>
          )}
          {item.resolution === "applied" && <p className="muted tiny" style={{ margin: 0 }}>Marked as done.</p>}
        </div>
      ))}
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export default SinceLastTimeList;
