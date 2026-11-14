import { useState } from "react";
import type { DetectedMode, ModeSetting, SummaryMode } from "../../types/w1-sum";
import { MODE_LABELS } from "./summaryData";

const OPTIONS: ModeSetting[] = [
  "AUTO",
  "GENERAL",
  "LECTURE",
  "INTERVIEW",
  "PROJECT",
  "ONE_ON_ONE",
];

interface Props {
  /** The mode the shown summary was written for. */
  mode: SummaryMode;
  /** Current setting (Meeting.mode or the user's override). */
  setting: ModeSetting;
  /** AUTO's guess, when it made one. */
  detected: DetectedMode | null;
  busy: boolean;
  onResummarize: (mode: ModeSetting) => void;
}

/**
 * Shows which mode the summary used (and AUTO's guess with its reason),
 * and lets the user pick another before re-summarizing.
 */
export function ModePicker({ mode, setting, detected, busy, onResummarize }: Props) {
  const [choice, setChoice] = useState<ModeSetting>(setting);

  return (
    <div className="mode-bar">
      <span className="badge tone-busy">{MODE_LABELS[mode]}</span>

      {detected && setting === "AUTO" && (
        <span className="muted tiny">
          Detected automatically ({Math.round(detected.confidence * 100)}%)
          {detected.reason ? `: ${detected.reason}` : ""}
        </span>
      )}

      <label className="muted tiny">
        <span className="sr-only">Summary mode</span>
        <select
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value as ModeSetting)}
        >
          {OPTIONS.map((option) => (
            <option key={option} value={option}>
              {MODE_LABELS[option]}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="secondary sm"
        disabled={busy}
        onClick={() => onResummarize(choice)}
      >
        {busy ? "Re-summarizing..." : "Re-summarize"}
      </button>
    </div>
  );
}
