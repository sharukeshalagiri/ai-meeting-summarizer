import type { MeetingProgress } from "../../types/w3-jobs";

/**
 * The pipeline's visible steps, in order (backend types/meeting.ts).
 * A stage is written when its job is queued, so the current one means
 * "waiting for or running this step"; earlier ones are done.
 */
export const PIPELINE_STEPS = [
  { stage: "TRANSCRIBING", label: "Transcribing" },
  { stage: "DIARIZING", label: "Attributing speakers" },
  { stage: "CLEANING", label: "Cleaning up the transcript" },
  { stage: "SUMMARIZING", label: "Generating summary" },
] as const;

const ACTIVE_STAGES: readonly string[] = [
  "ASSEMBLING",
  ...PIPELINE_STEPS.map((step) => step.stage),
];

export const isActiveStage = (stage: string | null | undefined): boolean =>
  stage != null && ACTIVE_STAGES.includes(stage);

/** Nothing more will happen without a new request (same rule as the SSE `end`). */
export const isSettled = (
  row: Pick<MeetingProgress, "status" | "processingStage">
): boolean => !isActiveStage(row.processingStage) && row.status !== "PROCESSING";

export const isFailed = (
  row: Pick<MeetingProgress, "status" | "processingStage">
): boolean => row.processingStage === "FAILED" || row.status === "FAILED";

/**
 * The user-facing part of processingError. Failures are stored as
 * "[STAGE/KIND] message"; notes (e.g. "a basic summary was used") have
 * no prefix.
 */
export const failureMessage = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const match = /^\[[A-Z_]+\/[A-Z_]+\] ([\s\S]*)$/.exec(value);
  return match ? match[1] : value;
};

/** The stage a stored failure names ("[SUMMARIZING/...] ..." -> SUMMARIZING). */
export const failedStage = (value: string | null | undefined): string | null =>
  /^\[([A-Z_]+)\//.exec(value ?? "")?.[1] ?? null;

/** Index of the current step in PIPELINE_STEPS (-1 before, length after). */
export const stepIndex = (stage: string | null | undefined): number => {
  if (stage === "DONE" || stage === "NO_SPEECH") return PIPELINE_STEPS.length;
  return PIPELINE_STEPS.findIndex((step) => step.stage === stage);
};
