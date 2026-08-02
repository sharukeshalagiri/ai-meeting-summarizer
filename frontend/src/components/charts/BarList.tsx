import type { TrendEntry } from "../../types/meeting";

interface Props {
  data: TrendEntry[];
  /** Shown under the heading when there is nothing to plot. */
  empty: string;
  /** Word describing one unit, used in the accessible label. */
  unit?: string;
}

/**
 * Horizontal magnitude comparison.
 *
 * A bar list rather than a column chart because the labels are
 * variable-length words (keywords, topic names, owners) which would
 * collide or need rotating on a horizontal axis. One hue: these encode
 * magnitude, not identity, so a categorical palette would imply a
 * distinction that is not there.
 */
function BarList({ data, empty, unit = "mention" }: Props) {
  if (data.length === 0) {
    return <p className="muted">{empty}</p>;
  }

  // Scale against the largest value so the top bar always fills the
  // track and the comparison stays legible on small counts.
  const max = Math.max(...data.map((entry) => entry.count), 1);

  return (
    <ul className="bar-list">
      {data.map((entry) => (
        <li key={entry.label} className="bar-row">
          <span className="bar-label" title={entry.label}>
            {entry.label}
          </span>

          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: `${(entry.count / max) * 100}%` }}
              role="img"
              aria-label={`${entry.label}: ${entry.count} ${unit}${
                entry.count === 1 ? "" : "s"
              }`}
            />
          </span>

          <span className="bar-value">{entry.count}</span>
        </li>
      ))}
    </ul>
  );
}

export default BarList;
