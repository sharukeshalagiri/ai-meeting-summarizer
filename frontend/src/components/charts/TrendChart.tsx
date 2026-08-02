import { useId, useMemo, useState } from "react";
import type { DailyPoint } from "../../types/meeting";

interface Props {
  data: DailyPoint[];
  empty: string;
}

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { top: 16, right: 16, bottom: 28, left: 34 };

const formatDay = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00`);

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

/**
 * Meetings per day.
 *
 * Hand-drawn SVG rather than a charting library: it is one series on a
 * linear scale, and a dependency would add more bundle weight than the
 * forty lines it replaces. The viewBox scales to the container, so it
 * stays responsive without measuring.
 */
function TrendChart({ data, empty }: Props) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const plot = useMemo(() => {
    const innerW = WIDTH - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;

    // A flat zero series would divide by zero; a floor of 1 also keeps
    // a single meeting from filling the whole height.
    const max = Math.max(...data.map((point) => point.meetings), 1);

    const x = (index: number) =>
      data.length > 1
        ? PAD.left + (index / (data.length - 1)) * innerW
        : PAD.left + innerW / 2;

    const y = (value: number) =>
      PAD.top + innerH - (value / max) * innerH;

    const points = data.map((point, index) => ({
      ...point,
      cx: x(index),
      cy: y(point.meetings),
    }));

    const line = points
      .map((point, index) =>
        `${index === 0 ? "M" : "L"}${point.cx.toFixed(1)},${point.cy.toFixed(1)}`
      )
      .join(" ");

    const area =
      points.length > 0
        ? `${line} L${points[points.length - 1]!.cx.toFixed(1)},${
            PAD.top + innerH
          } L${points[0]!.cx.toFixed(1)},${PAD.top + innerH} Z`
        : "";

    return { points, line, area, max, innerH };
  }, [data]);

  if (data.length === 0) {
    return <p className="muted">{empty}</p>;
  }

  const total = data.reduce((sum, point) => sum + point.meetings, 0);

  if (total === 0) {
    return <p className="muted">{empty}</p>;
  }

  const active = hover !== null ? plot.points[hover] : null;

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="trend-svg"
        role="img"
        aria-label={`Meetings per day. ${total} meetings over ${data.length} days.`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--chart-1)"
              stopOpacity="0.22"
            />
            <stop
              offset="100%"
              stopColor="var(--chart-1)"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        {/* Gridlines carry the values that are not directly labelled. */}
        {[0, 0.5, 1].map((fraction) => {
          const value = Math.round(plot.max * fraction);
          const y = PAD.top + plot.innerH * (1 - fraction);

          return (
            <g key={fraction}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y}
                y2={y}
                className="grid-line"
              />
              <text x={0} y={y + 4} className="axis-text">
                {value}
              </text>
            </g>
          );
        })}

        <path d={plot.area} fill={`url(#${gradientId})`} />

        <path
          d={plot.line}
          fill="none"
          stroke="var(--chart-1)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {active && (
          <line
            x1={active.cx}
            x2={active.cx}
            y1={PAD.top}
            y2={PAD.top + plot.innerH}
            className="crosshair"
          />
        )}

        {plot.points.map((point, index) => (
          <g key={point.date}>
            {/* Invisible wide target: the dots are far too small to
                hover reliably. */}
            <rect
              x={point.cx - WIDTH / data.length / 2}
              y={PAD.top}
              width={WIDTH / data.length}
              height={plot.innerH}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
            />

            {(hover === index || point.meetings === plot.max) && (
              <circle
                cx={point.cx}
                cy={point.cy}
                r="4.5"
                fill="var(--chart-1)"
                stroke="var(--surface)"
                strokeWidth="2"
              />
            )}
          </g>
        ))}

        {/* First and last day only; every label would collide. */}
        <text x={PAD.left} y={HEIGHT - 8} className="axis-text">
          {formatDay(data[0]!.date)}
        </text>

        <text
          x={WIDTH - PAD.right}
          y={HEIGHT - 8}
          textAnchor="end"
          className="axis-text"
        >
          {formatDay(data[data.length - 1]!.date)}
        </text>
      </svg>

      <figcaption
        className={`chart-tooltip ${active ? "is-visible" : ""}`}
        aria-live="polite"
      >
        {active
          ? `${formatDay(active.date)} — ${active.meetings} meeting${
              active.meetings === 1 ? "" : "s"
            }${
              active.durationMin > 0 ? `, ${active.durationMin} min` : ""
            }`
          : " "}
      </figcaption>
    </figure>
  );
}

export default TrendChart;
