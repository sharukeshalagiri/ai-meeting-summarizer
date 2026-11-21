import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getErrorMessage } from "../../api/api";
import { listSeries, setMeetingSeries } from "../../api/account";
import type { SeriesSummary } from "../../types/account";

const NEW = "__new__";

/**
 * Links a meeting to a recurring series (or a new one). The next
 * summary in the series then reports what happened to this meeting's
 * open tasks ("Since last time").
 */
function SeriesPicker({
  meetingId,
  seriesId,
  onChange,
}: {
  meetingId: string;
  seriesId: string | null;
  onChange: (seriesId: string | null) => void;
}) {
  const [series, setSeries] = useState<SeriesSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listSeries().then(setSeries, (err) => setError(getErrorMessage(err)));
  }, []);

  const save = async (body: { seriesId: string | null } | { name: string }) => {
    setSaving(true);
    setError(null);
    try {
      const result = await setMeetingSeries(meetingId, body);
      if ("name" in body) setSeries(await listSeries());
      setCreating(false);
      setName("");
      onChange(result.seriesId);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="series-picker acct">
      <label htmlFor="series" style={{ margin: 0 }}>
        Series
      </label>
      <select
        id="series"
        value={creating ? NEW : seriesId ?? ""}
        disabled={saving || series === null}
        onChange={(event) => {
          const value = event.target.value;
          if (value === NEW) return setCreating(true);
          setCreating(false);
          void save({ seriesId: value || null });
        }}
      >
        <option value="">None</option>
        {(series ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value={NEW}>New series…</option>
      </select>
      {creating && (
        <form
          className="acct-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void save({ name: name.trim() });
          }}
        >
          <input type="text" aria-label="New series name" placeholder="Weekly sync" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
          <button type="submit" className="sm" disabled={saving || !name.trim()}>
            Add
          </button>
        </form>
      )}
      {seriesId && !creating && (
        <Link to={`/prep/${seriesId}`} className="tiny">
          Prep for next time
        </Link>
      )}
      {error && (
        <span role="alert" className="tiny" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

export default SeriesPicker;
