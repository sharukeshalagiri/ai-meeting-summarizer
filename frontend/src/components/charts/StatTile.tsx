import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  hint?: string;
  /** Optional progress ratio, 0-1, rendered as a meter under the value. */
  meter?: number;
}

/**
 * One headline number.
 *
 * A stat tile rather than a one-bar chart: a single current value has
 * no comparison to make, so the number itself is the clearest form.
 */
function StatTile({ label, value, hint, meter }: Props) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>

      <span className="stat-value">{value}</span>

      {typeof meter === "number" && (
        <span
          className="meter"
          role="img"
          aria-label={`${Math.round(meter * 100)} percent`}
        >
          <span
            className="meter-fill"
            style={{
              width: `${Math.min(100, Math.max(0, meter * 100))}%`,
            }}
          />
        </span>
      )}

      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export default StatTile;
