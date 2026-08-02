import { useEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "../types/meeting";

interface Props {
  segments: Segment[];
  /** Flat text, used for meetings recorded before diarization. */
  fallback?: string | null;
  /** Segment to scroll to and highlight, e.g. from a chat citation. */
  focusMs?: number | null;
}

/**
 * Speaker-attributed transcript reader.
 *
 * Consecutive segments from one speaker are merged into a turn: the
 * raw segments are as short as a clause, and one row each reads as a
 * wall of fragments rather than a conversation.
 */
function TranscriptView({ segments, fallback, focusMs }: Props) {
  const [query, setQuery] = useState("");
  const focusRef = useRef<HTMLDivElement>(null);

  const turns = useMemo(() => {
    const grouped: {
      speaker: string;
      text: string;
      startMs: number;
      endMs: number;
      timestamp: string;
    }[] = [];

    for (const segment of segments) {
      const last = grouped[grouped.length - 1];

      if (last && last.speaker === segment.speaker) {
        last.text = `${last.text} ${segment.text}`;
        last.endMs = segment.endMs;
      } else {
        grouped.push({
          speaker: segment.speaker,
          text: segment.text,
          startMs: segment.startMs,
          endMs: segment.endMs,
          timestamp: segment.timestamp,
        });
      }
    }

    return grouped;
  }, [segments]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) return turns;

    return turns.filter(
      (turn) =>
        turn.text.toLowerCase().includes(needle) ||
        turn.speaker.toLowerCase().includes(needle)
    );
  }, [turns, query]);

  // Bring a cited moment into view when arriving from a chat answer.
  useEffect(() => {
    if (focusMs != null) {
      focusRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [focusMs, filtered]);

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

  const speakers = [...new Set(turns.map((turn) => turn.speaker))];

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

        <p className="muted tiny">
          {speakers.length} speaker{speakers.length === 1 ? "" : "s"}{" "}
          &middot; {turns.length} turn{turns.length === 1 ? "" : "s"}
          {query && ` · ${filtered.length} matching`}
        </p>
      </div>

      <div className="content-box transcript-body">
        {filtered.length === 0 ? (
          <p className="muted">
            Nothing in this transcript matches &ldquo;{query}&rdquo;.
          </p>
        ) : (
          filtered.map((turn) => {
            // A citation points at a segment; highlight the turn that
            // absorbed it.
            const isFocused =
              focusMs != null &&
              focusMs >= turn.startMs &&
              focusMs <= turn.endMs;

            return (
              <div
                key={`${turn.startMs}-${turn.speaker}`}
                ref={isFocused ? focusRef : undefined}
                className={`turn ${isFocused ? "is-focused" : ""}`}
              >
                <div className="turn-head">
                  <span className="speaker-chip">{turn.speaker}</span>
                  <span className="turn-time">{turn.timestamp}</span>
                </div>

                <p className="turn-text">{turn.text}</p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default TranscriptView;
