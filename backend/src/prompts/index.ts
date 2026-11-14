import type { SummaryMode } from "../types/summary";
import { classifyV1 } from "./classify.v1";
import { cleanV1 } from "./clean.v1";
import { extractV1 } from "./extract.v1";
import { interviewV1 } from "./modes/interview.v1";
import { lectureV1 } from "./modes/lecture.v1";
import { oneOnOneV1 } from "./modes/oneOnOne.v1";
import { projectV1 } from "./modes/project.v1";
import { reduceV1 } from "./reduce.v1";
import { verifyV1 } from "./verify.v1";
import { promptKey, type ModePromptDefinition, type PromptDefinition } from "./types";

/**
 * The prompt versions in use. Bumping a prompt means adding its next
 * `*.vN.ts` file and changing the entry here; old files stay so a stored
 * summary's `prompts` map can still be traced to its exact wording.
 */
export const PROMPTS = {
  classify: classifyV1,
  clean: cleanV1,
  extract: extractV1,
  reduce: reduceV1,
  verify: verifyV1,
} as const satisfies Record<string, PromptDefinition>;

/** Mode-specific additions; GENERAL has none. */
export const MODE_PROMPTS: Record<SummaryMode, ModePromptDefinition | null> = {
  GENERAL: null,
  LECTURE: lectureV1,
  INTERVIEW: interviewV1,
  PROJECT: projectV1,
  ONE_ON_ONE: oneOnOneV1,
};

/** e.g. { clean: "clean.v1", extract: "extract.v1", mode: "mode.lecture.v1" } */
export const promptVersions = (
  mode: SummaryMode,
  used: (keyof typeof PROMPTS)[]
): Record<string, string> => {
  const versions: Record<string, string> = {};

  for (const name of used) versions[name] = promptKey(PROMPTS[name]);

  const modePrompt = MODE_PROMPTS[mode];
  if (modePrompt) versions.mode = promptKey(modePrompt);

  return versions;
};

/** EXTRACT/REDUCE/VERIFY system text with the mode's rules appended. */
export const withMode = (prompt: PromptDefinition, mode: SummaryMode): string => {
  const modePrompt = MODE_PROMPTS[mode];

  return modePrompt ? `${prompt.system}\n\n${modePrompt.system}` : prompt.system;
};

export { promptKey };
export type { ModePromptDefinition, PromptDefinition };
