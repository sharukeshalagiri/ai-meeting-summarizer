/**
 * Shared formatting, so a duration reads the same on a card, a detail
 * page, and a stat tile.
 */

/**
 * Human-readable length of a recording.
 *
 * Falls back to seconds under a minute: rounding a 40-second clip to
 * "0 min" reads as missing data rather than a short meeting.
 */
export const formatDuration = (
  seconds: number | null | undefined
): string | null => {
  if (!seconds || seconds <= 0) return null;

  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

/** Same, for totals already expressed in whole minutes. */
export const formatMinutes = (minutes: number): string => {
  if (minutes <= 0) return "0m";

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
};

/** Locale-aware short date, used wherever a meeting date appears. */
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
