import { useAudioPlayer } from "../../lib/audio/useAudioPlayer";
import type { Evidence, Sourced } from "../../types/w1-sum";
import { formatOffset } from "./summaryData";

/**
 * Speaker + timestamp chip linking a summary item to the moment it was
 * said. Uses jumpToSegment(idx) from the UI contract: it switches to the
 * transcript, scrolls to seg-<idx>, highlights it and, when the meeting
 * has a recording, plays from there. Live meetings have no audio yet,
 * so the same call degrades to scroll + highlight; the label says which.
 */
export function EvidenceChip({ evidence }: { evidence: Evidence }) {
  const { jumpToSegment, hasAudio } = useAudioPlayer();
  const time = formatOffset(evidence.startMs);

  return (
    <button
      type="button"
      className="evidence-chip"
      onClick={() => jumpToSegment(evidence.idx)}
      title={hasAudio ? `Play from ${time}` : `Show at ${time} in the transcript`}
      aria-label={`${evidence.speaker} at ${time}: ${
        hasAudio ? "play from here" : "show in transcript"
      }`}
    >
      <span>{evidence.speaker}</span>
      <span className="evidence-time">
        {hasAudio ? "▶ " : ""}
        {time}
      </span>
    </button>
  );
}

/** Up to `max` evidence chips plus the "needs review" badge. */
export function SourceChips({
  item,
  max = 2,
}: {
  item: Pick<Sourced, "evidence" | "needsReview">;
  max?: number;
}) {
  const shown = item.evidence.slice(0, max);
  const hidden = item.evidence.length - shown.length;

  return (
    <span className="sum-chips">
      {shown.map((evidence) => (
        <EvidenceChip key={evidence.idx} evidence={evidence} />
      ))}
      {hidden > 0 && <span className="chip">+{hidden}</span>}
      {item.needsReview && (
        <span
          className="badge review-badge"
          title="Low confidence: please confirm against the transcript"
        >
          Needs review
        </span>
      )}
    </span>
  );
}
