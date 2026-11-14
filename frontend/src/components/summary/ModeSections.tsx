import type {
  InterviewSection,
  LectureSection,
  OneOnOneSection,
  ProjectSection,
  SummaryV2,
} from "../../types/w1-sum";
import { Block, ItemBlock, ItemList } from "./ItemList";
import { formatDue } from "./summaryData";

/** "text (due ...)" for assignments with a spoken deadline. */
const withDue = (
  text: string,
  dueSpoken: string | null,
  dueDate: string | null
) => {
  if (!dueSpoken && !dueDate) return text;
  const resolved = dueDate ? formatDue(dueDate) : null;
  const due = dueSpoken
    ? `${dueSpoken}${resolved ? ` (${resolved})` : ""}`
    : resolved;
  return `${text} (due ${due})`;
};

function Lecture({ section }: { section: LectureSection }) {
  const flagged = section.examQuestions.flaggedByLecturer;
  const likely = section.examQuestions.likely;

  return (
    <>
      <Block title="Exam questions" count={flagged.length + likely.length}>
        <ItemBlock
          sub
          title="Flagged by the lecturer"
          items={flagged}
          render={(item) => item.question}
        />
        <ItemBlock
          sub
          title="Likely"
          items={likely}
          render={(item) => (
            <>
              {item.question}
              {item.reason && <span className="muted"> — {item.reason}</span>}
            </>
          )}
        />
      </Block>

      <ItemBlock
        title="Assignments"
        items={section.assignments}
        render={(item) => withDue(item.task, item.dueSpoken, item.dueDate)}
      />
      <ItemBlock
        title="Outline"
        items={section.outline}
        render={(item) => item.text}
      />
      <ItemBlock
        title="Definitions"
        items={section.definitions}
        render={(item) => (
          <>
            <strong>{item.term}</strong> — {item.definition}
          </>
        )}
      />
      <ItemBlock
        title="Formulas"
        items={section.formulas}
        render={(item) => (
          <>
            <code>{item.expression}</code>
            {item.meaning && <span> — {item.meaning}</span>}
          </>
        )}
      />
      <ItemBlock
        title="Study checklist"
        items={section.studyChecklist}
        render={(item) => item.text}
      />
    </>
  );
}

function Interview({ section }: { section: InterviewSection }) {
  return (
    <>
      <ItemBlock
        title="Questions and answers"
        items={section.qa}
        render={(item) => (
          <>
            <strong>{item.question}</strong>
            {item.answerSummary && <span> — {item.answerSummary}</span>}
          </>
        )}
      />
      <ItemBlock
        title="Strengths"
        items={section.strengths}
        render={(item) => item.text}
      />
      <ItemBlock
        title="Concerns"
        items={section.concerns}
        render={(item) => item.text}
      />
      <ItemBlock
        title="Questions I struggled with"
        items={section.struggledWith}
        render={(item) => item.text}
      />
      <ItemBlock
        title="Follow-ups"
        items={section.followUps}
        render={(item) => item.text}
      />
      <ItemBlock
        title="Next steps"
        items={section.nextSteps}
        render={(item) => item.text}
      />
    </>
  );
}

function Project({ section }: { section: ProjectSection }) {
  const people = section.people.filter(
    (person) => person.done.length + person.next.length + person.blockers.length > 0
  );

  return (
    <>
      <Block title="By person" count={people.length}>
        {people.map((person) => (
          <div key={person.name}>
            <h4 className="sum-subhead">{person.name || "Unattributed"}</h4>
            {person.done.length > 0 && (
              <ItemList
                items={person.done}
                render={(item) => <>Done: {item.text}</>}
              />
            )}
            {person.next.length > 0 && (
              <ItemList
                items={person.next}
                render={(item) => <>Next: {item.text}</>}
              />
            )}
            {person.blockers.length > 0 && (
              <ItemList
                items={person.blockers}
                render={(item) => <>Blocked: {item.text}</>}
              />
            )}
          </div>
        ))}
      </Block>
      <ItemBlock title="Risks" items={section.risks} render={(item) => item.text} />
    </>
  );
}

function OneOnOne({ section }: { section: OneOnOneSection }) {
  return (
    <>
      <ItemBlock
        title="Feedback"
        items={section.feedback}
        render={(item) => (
          <>
            <strong>{item.speaker}:</strong> {item.text}
          </>
        )}
      />
      <ItemBlock
        title="Commitments"
        items={section.commitments}
        render={(item) => (
          <>
            <strong>{item.who}:</strong> {item.text}
          </>
        )}
      />
      <ItemBlock
        title="Next topics"
        items={section.nextTopics}
        render={(item) => item.text}
      />
    </>
  );
}

/**
 * The mode-specific part of a v2 summary. Only the section for the
 * summary's mode is present in the data; empty lists render nothing.
 */
export function ModeSections({ summary }: { summary: SummaryV2 }) {
  const { lecture, interview, project, oneOnOne } = summary.sections;

  return (
    <>
      {lecture && <Lecture section={lecture} />}
      {interview && <Interview section={interview} />}
      {project && <Project section={project} />}
      {oneOnOne && <OneOnOne section={oneOnOne} />}
    </>
  );
}
