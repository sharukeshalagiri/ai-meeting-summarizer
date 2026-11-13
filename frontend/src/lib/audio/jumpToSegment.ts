/**
 * DOM side of the UI contract: every rendered transcript segment carries
 * id="seg-<idx>" and data-start-ms. `idx` is TranscriptSegment.idx,
 * never an array position.
 */

export const segmentElementId = (idx: number) => `seg-${idx}`;

const HIGHLIGHT_CLASS = "seg-highlight";
const HIGHLIGHT_MS = 2000;

/**
 * Scrolls segment `idx` into view and briefly highlights it. Returns
 * the segment's start in ms (from data-start-ms), or null if it is not
 * rendered.
 */
export function scrollToSegment(idx: number): number | null {
  const element = document.getElementById(segmentElementId(idx));

  if (!element) return null;

  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.add(HIGHLIGHT_CLASS);
  window.setTimeout(
    () => element.classList.remove(HIGHLIGHT_CLASS),
    HIGHLIGHT_MS
  );

  const start = Number(element.dataset.startMs);

  return Number.isFinite(start) ? start : null;
}
