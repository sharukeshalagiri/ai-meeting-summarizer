/**
 * A versioned prompt. Each prompt lives in its own `<id>.v<version>.ts`
 * file; changing wording means adding a v2 file and pointing the
 * registry at it, so a stored summary's `prompts` map always names the
 * exact text that produced it.
 */
export interface PromptDefinition {
  /** Stable name, e.g. "extract" or "mode.lecture". */
  id: string;
  version: number;
  /**
   * Which model runs it: "clean" is the cheap, high-volume labelling
   * model (GEMINI_CLEAN_MODEL); "main" is GEMINI_MODEL.
   */
  model: "main" | "clean";
  /** System instruction sent with the call. */
  system: string;
}

/** Extra instructions and output schema a mode adds to EXTRACT/VERIFY. */
export interface ModePromptDefinition extends Omit<PromptDefinition, "model"> {
  /** Key under `sections` in the summary, e.g. "lecture". */
  sectionKey: "lecture" | "interview" | "project" | "oneOnOne";
  /** Gemini responseSchema for the section. */
  schema: Record<string, unknown>;
}

export const promptKey = (prompt: { id: string; version: number }) =>
  `${prompt.id}.v${prompt.version}`;
