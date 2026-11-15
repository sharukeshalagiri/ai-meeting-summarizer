import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { segmentElementId } from "../lib/audio/jumpToSegment";
import { useAudioPlayer } from "../lib/audio/useAudioPlayer";
import type { SpeakerSegment } from "../types/w2-spk";
import SpeakerChip from "./transcript/SpeakerChip";
import {
  buildTurns,
  filterTurns,
  foldLabel,
  isHiddenTurn,
  isNoise,
  partRuns,
} from "./transcript/turns";
import { useSpeakers } from "./transcript/useSpeakers";
import "./transcript/transcript.css";

interface Props {
  segments: SpeakerSegment[];
  /** Flat text, used for meetings recorded before diarization. */
  fallback?: string | null;
  /** Segment to scroll to and highlight, e.g. from a chat citation. */
  focusMs?: number | null;
}

const HIGHLIGHT_CLASS = "seg-highlight";

/**
 * Speaker-attributed transcript reader.
 *
 * - Consecutive segments from one speaker merge into a turn.
 * - Click a speaker chip to rename that speaker everywhere (segments
 *   now, summary and tasks at read time, logged as a Correction); a
 *   suggested name can be accepted from the chip.
 * - "Hide noise" (on by default) folds lines the summary's CLEAN pass
 *   labelled small talk, logistics, filler or off topic.
 *
 * UI contract: every segment renders as <span id="seg-<idx>"
 * data-start-ms>, hidden ones included, so jumpToSegment always finds
 * its target; a jump to a hidden line unfolds it.
 */
function TranscriptView({ segments, fallback, focusMs }: Props) {
  const { id: meetingId } = useParams();
  const [query, setQuery] = useState("");
  const [hideNoise, setHideNoise] = useState(true);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const { seekTo, hasAudio } = useAudioPlayer();
  const focusRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** A folded segment a jump targeted, scrolled to once it renders. */
  const pendingScroll = useRef<number | null>(null);

  const { speakers, names, rename, accept, busyKey, error, notice } = useSpeakers(
    meetingId,
    segments.length
  );

  const turns = useMemo(
    () => buildTurns(segments, { names, hideNoise, revealed }),
    [segments, names, hideNoise, revealed]
  );

  const filtered = useMemo(() => filterTurns(turns, query), [turns, query]);

  const noiseCount = useMemo(() => segments.filter(isNoise).length, [segments]);

  const reveal = (idx: number[]) =>
    setRevealed((current) => new Set([...current, ...idx]));

  // Bring a cited moment into view when arriving from a chat answer.
  useEffect(() => {
    if (focusMs != null) {
      focusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusMs, filtered]);

  // A jump (jumpToSegment) to a folded line highlights a hidden span,
  // which cannot be scrolled to. Unfold it, then scroll once it shows.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof MutationObserver === "undefined") return;

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement;
        if (
          target.dataset?.hiddenSeg === "true" &&
          target.classList.contains(HIGHLIGHT_CLASS)
        ) {
          const idx = Number(target.id.replace(/^seg-/, ""));
          if (Number.isFinite(idx)) {
            pendingScroll.current = idx;
            reveal([idx]);
          }
        }
      }
    });

    observer.observe(body, { attributes: true, attributeFilter: ["class"], subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const idx = pendingScroll.current;
    if (idx == null) return;
    pendingScroll.current = null;
    document
      .getElementById(segmentElementId(idx))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [turns]);

  if (segments.length === 0) {
    return (
      <div className="content-box">
        {fallback ? (
          <p className="transcript-plain">{fallback}</p>
        ) : (
          <span className="muted">Transcript not generated.</span>
        )}
      </div>
    );
  }

  const speakerCount = new Set(turns.map((turn) => turn.key)).size;

  const renderSpan = (part: SpeakerSegment, first: boolean, hidden: boolean) => (
    <span
      key={part.idx}
      id={segmentElementId(part.idx)}
      data-start-ms={part.startMs}
      data-hidden-seg={hidden ? "true" : undefined}
      hidden={hidden}
      className="seg"
    >
      {first ? "" : " "}
      {part.text}
    </span>
  );

  return (
    <div className="transcript">
      <div className="transcript-toolbar">
        <div className="field inline">
          <label htmlFor="transcript-search" className="sr-only">
            Search the transcript
          </label>
          <input
            id="transcript-search"
            type="search"
            placeholder="Search the transcript"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {noiseCount > 0 && (
          <label className="noise-toggle">
            <input
              type="checkbox"
              checked={hideNoise}
              onChange={(event) => {
                setHideNoise(event.target.checked);
                setRevealed(new Set());
              }}
            />
            Hide noise
            <span className="muted tiny">
              ({noiseCount} line{noiseCount === 1 ? "" : "s"})
            </span>
          </label>
        )}

        <p className="muted tiny">
          {speakerCount} speaker{speakerCount === 1 ? "" : "s"} &middot;{" "}
          {turns.length} turn{turns.length === 1 ? "" : "s"}
          {query && ` · ${filtered.length} matching`}
        </p>
      </div>

      {(error || notice) && (
        <p className={`tiny ${error ? "transcript-error" : "muted"}`} role="status">
          {error ?? notice}
        </p>
      )}

      <div className="content-box transcript-body" ref={bodyRef}>
        {filtered.length === 0 ? (
          <p className="muted">
            Nothing in this transcript matches &ldquo;{query}&rdquo;.
          </p>
        ) : (
          filtered.map((turn) => {
            // A citation points at a segment; highlight the turn that
            // absorbed it.
            const isFocused =
              focusMs != null && focusMs >= turn.startMs && focusMs <= turn.endMs;
            const speaker = speakers.get(turn.key);
            const allHidden = isHiddenTurn(turn);

            return (
              <div
                key={turn.parts[0].idx}
                ref={isFocused ? focusRef : undefined}
                className={`turn ${isFocused ? "is-focused" : ""} ${
                  allHidden ? "turn-folded" : ""
                }`}
              >
                <div className="turn-head">
                  <SpeakerChip
                    name={turn.speaker}
                    isMe={turn.isMe || !!speaker?.isMe}
                    suggestion={speaker?.suggestion ?? null}
                    editable={!!meetingId}
                    busy={busyKey === turn.key}
                    onRename={(name) => rename(turn.key, name)}
                    onAccept={() => accept(turn.key)}
                  />
                  {hasAudio ? (
                    <button
                      type="button"
                      className="turn-time turn-time-button"
                      title="Play from here"
                      onClick={() => seekTo(turn.startMs)}
                    >
                      {turn.timestamp}
                    </button>
                  ) : (
                    <span className="turn-time">{turn.timestamp}</span>
                  )}
                </div>

                {/* UI contract: one anchor per segment, id="seg-<idx>"
                    using TranscriptSegment.idx (sparse for live). */}
                <p className="turn-text">
                  {partRuns(turn).map((run, r) =>
                    run.hidden ? (
                      <span key={`fold-${run.parts[0].idx}`}>
                        <button
                          type="button"
                          className="noise-fold"
                          onClick={() => reveal(run.parts.map((p) => p.idx))}
                        >
                          {foldLabel(run.parts)}
                        </button>
                        {run.parts.map((part) => renderSpan(part, true, true))}
                      </span>
                    ) : (
                      run.parts.map((part, i) => renderSpan(part, r === 0 && i === 0, false))
                    )
                  )}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default TranscriptView;
