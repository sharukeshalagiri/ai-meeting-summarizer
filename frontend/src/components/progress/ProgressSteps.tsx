import { PIPELINE_STEPS, stepIndex } from "./stages";

interface Props {
  /** Meeting.processingStage, or null before the pipeline was queued. */
  stage: string | null | undefined;
  /** Steps shown before the pipeline's own (e.g. the upload). */
  before?: { label: string; done: boolean; detail?: string }[];
  /** The run failed: the current step is marked as failed. */
  failed?: boolean;
}

/**
 * The pipeline as a checklist: earlier steps done, the current one
 * spinning, later ones pending. Used by the upload page and the meeting
 * page while a job runs.
 */
function ProgressSteps({ stage, before = [], failed = false }: Props) {
  const pipelineStarted = before.every((step) => step.done);
  const current = pipelineStarted ? stepIndex(stage) : -1;
  const allDone = current >= PIPELINE_STEPS.length;

  const rows = [
    ...before.map((step, index) => ({
      key: `before-${index}`,
      label: step.label,
      detail: step.detail,
      done: step.done,
      active: !step.done && before.slice(0, index).every((s) => s.done),
    })),
    ...PIPELINE_STEPS.map((step, index) => ({
      key: step.stage,
      label: step.label,
      detail: undefined as string | undefined,
      done: allDone || index < current,
      active: index === current,
    })),
  ];

  return (
    <ol className="steps">
      {rows.map((row) => (
        <li
          key={row.key}
          className={`step ${row.done ? "step-done" : ""} ${row.active ? "step-active" : ""}`}
        >
          <span className="step-icon">
            {row.done ? (
              "✓"
            ) : row.active && failed ? (
              "✗"
            ) : row.active ? (
              <span className="spinner" />
            ) : (
              "○"
            )}
          </span>
          <span>
            {row.label}
            {row.active && row.detail ? ` ${row.detail}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default ProgressSteps;
