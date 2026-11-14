import { useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { getErrorMessage } from "../api/api";
import { resummarize } from "../api/w1-sum";
import { useFetch } from "../hooks/useFetch";
import type { Sentiment, StructuredSummary } from "../types/meeting";
import type {
  ActionItemRow,
  ModeSetting,
  SummaryReview,
  SummaryV2,
} from "../types/w1-sum";
import { ActionItemReview } from "./summary/ActionItemReview";
import { Block, ItemBlock } from "./summary/ItemList";
import { ModePicker } from "./summary/ModePicker";
import { ModeSections } from "./summary/ModeSections";
import { formatDue, readSummaryV2 } from "./summary/summaryData";
import "./summary/summary.css";

interface Props {
  /**
   * Summary.data as stored: schema version 1 (StructuredSummary) or
   * version 2 (SummaryV2, schemaVersion: 2). MeetingDetails types it as
   * v1, so the version is detected at runtime.
   */
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

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase();

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

function SentimentBadge({ overall }: { overall: Sentiment }) {
  return (
    <span className={`badge ${SENTIMENT_TONE[overall] ?? "tone-neutral"}`}>
      {titleCase(overall)}
    </span>
  );
}

/**
 * Schema version 1 (summaries written before w1-sum). Unchanged from
 * the original view so old rows keep rendering exactly as before.
 */
function LegacySummary({ summary }: { summary: StructuredSummary }) {
  return (
    <div className="summary">
      <section className="summary-section">
        <div className="summary-head">
          <h3>Executive summary</h3>
          <SentimentBadge overall={summary.sentiment.overall} />
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
                  {titleCase(item.priority)}
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

/**
 * Schema version 2. What a reader acts on comes first (TL;DR, tasks,
 * deadlines, decisions), then the mode's own sections; everything else
 * is collapsed. Every item carries speaker/time chips that jump to the
 * segment it came from.
 */
function SummaryV2View({
  summary,
  meetingId,
  rows,
  onRowsChange,
}: {
  summary: SummaryV2;
  meetingId: string | undefined;
  rows: ActionItemRow[] | null;
  onRowsChange: (rows: ActionItemRow[]) => void;
}) {
  const taskCount = rows ? rows.length : summary.actionItems.length;
  const moreCount =
    summary.keyPoints.length +
    summary.openQuestions.length +
    summary.whoSaidWhat.length +
    summary.glossary.length +
    summary.nextSessionPrep.length +
    summary.keywords.length;

  return (
    <div className="summary">
      <section className="summary-section">
        <div className="summary-head">
          <h3>TL;DR</h3>
          <SentimentBadge overall={summary.sentiment.overall} />
        </div>

        <p className="lede">
          {summary.tldr || "Nothing substantive was discussed."}
        </p>
      </section>

      <Block title="Tasks" count={taskCount}>
        <ActionItemReview
          meetingId={meetingId}
          rows={rows}
          fallback={summary.actionItems}
          onRowsChange={onRowsChange}
        />
      </Block>

      <ItemBlock
        title="Deadlines and dates"
        items={summary.dates}
        render={(item) => (
          <>
            <strong>{item.spoken}</strong>
            {item.date && item.date !== item.spoken && (
              <span className="muted"> ({formatDue(item.date)})</span>
            )}
            {item.description && <span> — {item.description}</span>}
          </>
        )}
      />

      <ItemBlock
        title="Decisions"
        items={summary.decisions}
        render={(item) => (
          <>
            {item.text}
            {item.decidedBy && (
              <span className="muted"> — {item.decidedBy}</span>
            )}
          </>
        )}
      />

      <ModeSections summary={summary} />

      {moreCount > 0 && (
        <details className="sum-details">
          <summary>More from this meeting ({moreCount})</summary>

          <ItemBlock
            title="Key points"
            items={summary.keyPoints}
            render={(item) => item.text}
          />
          <ItemBlock
            title="Open questions"
            items={summary.openQuestions}
            render={(item) => item.text}
          />
          <ItemBlock
            title="Who said what"
            items={summary.whoSaidWhat}
            render={(item) => (
              <>
                <strong>{item.speaker}:</strong> {item.text}
              </>
            )}
          />
          <ItemBlock
            title="Glossary"
            items={summary.glossary}
            render={(item) => (
              <>
                <strong>{item.term}</strong> — {item.definition}
              </>
            )}
          />
          <ItemBlock
            title="Prepare for next time"
            items={summary.nextSessionPrep}
            render={(item) => item.text}
          />
          <Block title="Keywords" count={summary.keywords.length}>
            <div className="keyword-cloud">
              {summary.keywords.map((keyword) => (
                <span key={keyword} className="chip">
                  {keyword}
                </span>
              ))}
            </div>
          </Block>
          {summary.sentiment.rationale && (
            <p className="muted tiny">{summary.sentiment.rationale}</p>
          )}
        </details>
      )}
    </div>
  );
}

/**
 * Structured meeting intelligence, for both summary schema versions.
 * The meeting id comes from the route (MeetingDetails is not changed),
 * and a re-summarize replaces the shown summary in place.
 */
function SummaryView({ summary }: Props) {
  const { id: meetingId } = useParams();
  const review = useFetch<SummaryReview>(
    `/meetings/${meetingId ?? ""}/summary-review`
  );

  // The summary returned by a re-summarize, shown instead of the prop
  // (which belongs to MeetingDetails and is not refetched from here).
  const [fresh, setFresh] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const v2 = readSummaryV2(fresh ?? summary);
  const setting: ModeSetting = review.data?.modeSetting ?? v2?.modeSetting ?? "AUTO";

  const run = async (mode: ModeSetting) => {
    if (!meetingId) return;

    setBusy(true);
    setError(null);

    try {
      const result = await resummarize(meetingId, mode);
      const next = readSummaryV2(result.summary.data);

      setFresh(result.summary.data);
      review.setData({
        modeSetting: mode,
        summaryMode: next?.mode ?? null,
        detectedMode: next?.detectedMode ?? null,
        actionItems: result.actionItems,
      });
    } catch (err) {
      console.error(err);
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ModePicker
        // Re-mount when the server's setting changes so the select follows it.
        key={setting}
        mode={v2?.mode ?? "GENERAL"}
        setting={setting}
        detected={v2?.detectedMode ?? review.data?.detectedMode ?? null}
        busy={busy}
        onResummarize={(mode) => void run(mode)}
      />

      {!v2 && (
        <p className="muted tiny">
          This summary uses the older format. Re-summarize to get evidence
          links, deadlines and mode-specific sections.
        </p>
      )}

      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      {v2 ? (
        <SummaryV2View
          summary={v2}
          meetingId={meetingId}
          rows={review.data?.actionItems ?? null}
          onRowsChange={(rows) =>
            review.data && review.setData({ ...review.data, actionItems: rows })
          }
        />
      ) : (
        <LegacySummary summary={(fresh ?? summary) as StructuredSummary} />
      )}
    </>
  );
}

export default SummaryView;
