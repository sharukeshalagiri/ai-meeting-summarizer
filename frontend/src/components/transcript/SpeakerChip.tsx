import { useId, useState, type FormEvent } from "react";
import type { NameSignal, SpeakerView } from "../../types/w2-spk";

const SIGNAL_TEXT: Record<NameSignal, string> = {
  self_intro: "introduced themself",
  roster: "in the participant list",
  addressed: "addressed by that name",
};

interface Props {
  name: string;
  isMe: boolean;
  suggestion: SpeakerView["suggestion"];
  /** False when the meeting is unknown (no rename possible). */
  editable: boolean;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onAccept: () => Promise<boolean>;
}

/**
 * A speaker's name on a transcript turn. Click to rename (every line of
 * that speaker, plus the summary and tasks at read time); a suggested
 * name (one signal, never applied automatically) can be accepted.
 */
function SpeakerChip({ name, isMe, suggestion, editable, busy, onRename, onAccept }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputId = useId();

  if (!editable) {
    return <span className={`speaker-chip ${isMe ? "is-me" : ""}`}>{name}</span>;
  }

  if (editing) {
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      const next = draft.trim();
      if (!next || next === name) {
        setEditing(false);
        return;
      }
      if (await onRename(next)) setEditing(false);
    };

    return (
      <form className="speaker-rename" onSubmit={submit}>
        <label className="sr-only" htmlFor={inputId}>
          New name for {name}
        </label>
        <input
          id={inputId}
          value={draft}
          maxLength={60}
          autoFocus
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
        />
        <button type="submit" className="sm" disabled={busy || !draft.trim()}>
          Save
        </button>
        <button type="button" className="sm ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </form>
    );
  }

  return (
    <span className="speaker-chip-group">
      <button
        type="button"
        className={`speaker-chip speaker-chip-button ${isMe ? "is-me" : ""}`}
        title={`Rename ${name}`}
        aria-label={`${name}. Rename this speaker`}
        disabled={busy}
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
      {suggestion && (
        <button
          type="button"
          className="speaker-suggestion"
          disabled={busy}
          title={`Suggested: ${suggestion.signals.map((s) => SIGNAL_TEXT[s]).join(", ")}`}
          onClick={() => void onAccept()}
        >
          {suggestion.name}?
          <span className="sr-only"> Accept this name</span>
        </button>
      )}
    </span>
  );
}

export default SpeakerChip;
