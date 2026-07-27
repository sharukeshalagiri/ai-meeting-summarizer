import type { StructuredSummary } from "../types/meeting";

interface Props {
  summary: StructuredSummary;
}

/** Renders one section, or a muted note when the model found nothing. */
function Section({
  title,
  empty,
  children,
  isEmpty,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
  isEmpty: boolean;
}) {
  return (
    <section className="summary-section">
      <h3>{title}</h3>

      {isEmpty ? <p className="muted">{empty}</p> : children}
    </section>
  );
}

/**
 * Renders the structured summary Gemini returns. Falls back to the
 * markdown field upstream when `data` is null (older summaries).
 */
function SummaryView({ summary }: Props) {
  return (
    <div className="summary">
      <section className="summary-section">
        <h3>Executive Summary</h3>
        <p>{summary.executiveSummary}</p>
      </section>

      <Section
        title="Key Decisions"
        empty="No decisions were recorded."
        isEmpty={summary.keyDecisions.length === 0}
      >
        <ul>
          {summary.keyDecisions.map((decision, index) => (
            <li key={index}>{decision}</li>
          ))}
        </ul>
      </Section>

      <Section
        title="Action Items"
        empty="No action items were recorded."
        isEmpty={summary.actionItems.length === 0}
      >
        <ul className="action-items">
          {summary.actionItems.map((item, index) => (
            <li key={index}>
              <span>{item.task}</span>

              {(item.owner || item.dueDate) && (
                <span className="meta">
                  {item.owner && (
                    <span className="chip">{item.owner}</span>
                  )}
                  {item.dueDate && (
                    <span className="chip">Due: {item.dueDate}</span>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Important Dates"
        empty="No dates were mentioned."
        isEmpty={summary.importantDates.length === 0}
      >
        <ul className="dates">
          {summary.importantDates.map((entry, index) => (
            <li key={index}>
              <strong>{entry.date}</strong>
              {entry.description && <span> — {entry.description}</span>}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Follow Ups"
        empty="No follow ups were recorded."
        isEmpty={summary.followUps.length === 0}
      >
        <ul>
          {summary.followUps.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export default SummaryView;
