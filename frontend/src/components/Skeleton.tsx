interface Props {
  rows?: number;
}

/**
 * Loading placeholder.
 *
 * Shaped like the content it replaces so the layout does not jump when
 * data arrives, which a centred spinner cannot avoid.
 */
export function Skeleton({ rows = 3 }: Props) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-card">
          <div className="skeleton-line" style={{ width: "40%" }} />
          <div className="skeleton-line" style={{ width: "85%" }} />
          <div className="skeleton-line" style={{ width: "60%" }} />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
