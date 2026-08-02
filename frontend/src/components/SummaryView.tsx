import type { ReactNode } from "react";
import type { Sentiment, StructuredSummary } from "../types/meeting";

interface Props {
  summary: StructuredSummary;
}

const SENTIMENT_TONE: Record<Sentiment, string> = {
  POSITIVE: "tone-good",
  NEUTRAL: "tone-neutral",
  MIXED: "tone-warning",
  NEGATIVE: "tone-critical",
};

const PRIORITY_TONE: Record<string, string> = {
  HIGH: "tone-critical",
  MEDIUM: "tone-warning",
  LOW: "tone-neutral",
};

/** Renders one section, or nothing at all when it is empty. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  // An empty section is normal — most meetings have no blockers — and
  // a column of "None recorded." reads as noise, so it is dropped
  // entirely rather than shown empty.
  if (count === 0) return null;

  return (
    <section className="summary-section">
      <h3>
        {title}
        <span className="section-count">{count}</span>
      </h3>

      {children}
    </section>
  );
}

const BulletList = ({ items }: { items: string[] }) => (
  <ul className="clean-list">
    {items.map((item, index) => (
      <li key={index}>{item}</li>
    ))}
  </ul>
);

/**
 * Renders structured meeting intelligence.
 *
 * Sections are ordered by what a reader wants first: the summary, then
 * what was decided, then what someone now has to do, then the things
 * that need attention.
 */
function SummaryView({ summary }: Props) {
  const sentimentTone =
    SENTIMENT_TONE[summary.sentiment.overall] ?? "tone-neutral";

  return (
    <div className="summary">
      <section className="summary-section">
        <div className="summary-head">
          <h3>Executive summary</h3>

          <span className={`badge ${sentimentTone}`}>
            {summary.sentiment.overall.charAt(0) +
              summary.sentiment.overall.slice(1).toLowerCase()}
          </span>
        </div>

        <p className="lede">{summary.executiveSummary}</p>

        {summary.sentiment.rationale && (
          <p className="muted tiny">{summary.sentiment.rationale}</p>
        )}
      </section>

      <Section title="Key decisions" count={summary.keyDecisions.length}>
        <BulletList items={summary.keyDecisions} />
      </Section>

      <Section title="Action items" count={summary.actionItems.length}>
        <ul className="action-items">
          {summary.actionItems.map((item, index) => (
            <li key={index}>
              <span className="action-task">{item.task}</span>

              <span className="meta">
                {item.owner && (
                  <span className="chip chip-owner">{item.owner}</span>
                )}

                {item.dueDate && (
                  <span className="chip">Due: {item.dueDate}</span>
                )}

                <span
                  className={`chip ${PRIORITY_TONE[item.priority] ?? ""}`}
                >
                  {item.priority.charAt(0) +
                    item.priority.slice(1).toLowerCase()}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Important dates"
        count={summary.importantDates.length}
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

      <Section title="Blockers" count={summary.blockers.length}>
        <BulletList items={summary.blockers} />
      </Section>

      <Section title="Risks" count={summary.risks.length}>
        <BulletList items={summary.risks} />
      </Section>

      <Section
        title="Open questions"
        count={summary.openQuestions.length}
      >
        <BulletList items={summary.openQuestions} />
      </Section>

      <Section
        title="Discussion topics"
        count={summary.discussionTopics.length}
      >
        <ul className="topics">
          {summary.discussionTopics.map((entry, index) => (
            <li key={index}>
              <strong>{entry.topic}</strong>
              {entry.summary && <span> — {entry.summary}</span>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Follow ups" count={summary.followUps.length}>
        <BulletList items={summary.followUps} />
      </Section>

      <Section title="Keywords" count={summary.keywords.length}>
        <div className="keyword-cloud">
          {summary.keywords.map((keyword, index) => (
            <span key={index} className="chip">
              {keyword}
            </span>
          ))}
        </div>
      </Section>
    </div>
  );
}

export default SummaryView;
