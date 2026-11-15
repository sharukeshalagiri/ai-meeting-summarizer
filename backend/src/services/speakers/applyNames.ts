/**
 * Speaker renames applied at READ time (pure; no I/O).
 *
 * A rename updates segments in place (they are w2-spk's), but the
 * summary JSON and action items are produced by the summary pipeline
 * (w1-sum) and must not be rewritten or regenerated for a rename. So
 * the response is projected instead: wherever the summary or a task
 * names a speaker, the current name is substituted.
 *
 * - An evidence object `{idx, speaker}` takes the speaker of segment
 *   `idx` as it is now (exact: segments are already renamed).
 * - Any other `speaker`, `owner` or `assignedBy` string is replaced
 *   when it equals (case-insensitively, whole string) an old name.
 *
 * Wired by the integrator (two one-line calls, see the PR):
 * `withSpeakerNames(meeting)` on GET /meetings/:id and
 * `withOwnerNames(items)` on GET /action-items.
 */

export type RenameMap = ReadonlyMap<string, string>;

const NAME_FIELDS = new Set(["speaker", "owner", "assignedBy"]);

/**
 * Old name (lowercase) -> current name, from renames in order.
 * Chains collapse: A->B then B->C maps both A and B to C. A rename back
 * to an earlier name (A->B, B->A) maps B to A and drops A's entry.
 */
export const buildRenameMap = (
  renames: { from: string; to: string }[]
): Map<string, string> => {
  const map = new Map<string, string>();

  for (const { from, to } of renames) {
    const source = from.trim();
    const target = to.trim();
    if (!source || !target || source.toLowerCase() === target.toLowerCase()) {
      continue;
    }

    for (const [key, value] of map) {
      if (value.toLowerCase() === source.toLowerCase()) map.set(key, target);
    }
    map.set(source.toLowerCase(), target);
    map.delete(target.toLowerCase());
  }

  return map;
};

const renameString = (value: string, renames: RenameMap): string =>
  renames.get(value.trim().toLowerCase()) ?? value;

const project = (
  value: unknown,
  renames: RenameMap,
  segmentSpeakers: ReadonlyMap<number, string>
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => project(item, renames, segmentSpeakers));
  }

  if (value === null || typeof value !== "object") return value;

  // Dates, Decimals and other class instances pass through untouched;
  // only plain JSON-like objects are walked.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(source)) {
    if (NAME_FIELDS.has(key) && typeof field === "string") {
      const fromSegment =
        key === "speaker" && typeof source.idx === "number"
          ? segmentSpeakers.get(source.idx)
          : undefined;
      out[key] = fromSegment ?? renameString(field, renames);
    } else {
      out[key] = project(field, renames, segmentSpeakers);
    }
  }

  return out;
};

/**
 * A copy of `meeting` with current speaker names in `summary.data` and
 * `actionItems` (owner, assignedBy, evidence). Everything else is
 * returned untouched, so it is safe on any meeting shape.
 */
export const applySpeakerNames = <
  T extends { summary?: unknown; actionItems?: unknown },
>(
  meeting: T,
  renames: RenameMap,
  segmentSpeakers: ReadonlyMap<number, string> = new Map()
): T => {
  if (renames.size === 0 && segmentSpeakers.size === 0) return meeting;

  const result = { ...meeting };

  const summary = meeting.summary as { data?: unknown } | null | undefined;
  if (summary && typeof summary === "object" && "data" in summary) {
    (result as Record<string, unknown>).summary = {
      ...summary,
      data: project(summary.data, renames, segmentSpeakers),
    };
  }

  if (Array.isArray(meeting.actionItems)) {
    (result as Record<string, unknown>).actionItems = project(
      meeting.actionItems,
      renames,
      segmentSpeakers
    );
  }

  return result;
};

/** Action items (any meetings) with owner names projected per meeting. */
export const applyOwnerNames = <T extends { meetingId: string }>(
  items: T[],
  renamesByMeeting: ReadonlyMap<string, RenameMap>
): T[] =>
  items.map((item) => {
    const renames = renamesByMeeting.get(item.meetingId);
    return renames && renames.size > 0
      ? (project(item, renames, new Map()) as T)
      : item;
  });
