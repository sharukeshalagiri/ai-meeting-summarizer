import type { ExpectedItem, ForbiddenItem, ProducedItem, Segment } from "./types";

/**
 * Deterministic matching, exactly as fixtures/transcripts/README.md
 * defines it: an expected item is found when a produced item of the same
 * kind contains every `match` term, case-insensitive. Matching is
 * one-to-one in key order, so one produced item that lumps two tasks
 * together only earns one of them.
 */

export const containsAll = (text: string, terms: string[]): boolean => {
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term.toLowerCase()));
};

/** expected id -> produced ref. */
export type Assignment = Map<string, string>;

export const matchExpected = (
  expected: ExpectedItem[],
  produced: ProducedItem[],
  /** Extra pairs (from the judge) tried after the deterministic pass. */
  extra: { expectedId: string; ref: string }[] = []
): Assignment => {
  const used = new Set<string>();
  const assignment: Assignment = new Map();

  for (const item of expected) {
    const hit = produced.find(
      (p) => p.kind === item.kind && !used.has(p.ref) && containsAll(p.text, item.match)
    );
    if (hit) {
      assignment.set(item.id, hit.ref);
      used.add(hit.ref);
    }
  }

  for (const pair of extra) {
    const item = expected.find((e) => e.id === pair.expectedId);
    const hit = produced.find((p) => p.ref === pair.ref);
    if (!item || !hit || assignment.has(item.id) || used.has(hit.ref) || hit.kind !== item.kind) continue;
    assignment.set(item.id, hit.ref);
    used.add(hit.ref);
  }

  return assignment;
};

/** Forbidden entries a produced item trips ("any" covers every kind). */
export const trapHits = (item: ProducedItem, forbidden: ForbiddenItem[]): ForbiddenItem[] =>
  forbidden.filter(
    (trap) => (trap.kind === "any" || trap.kind === item.kind) && containsAll(item.text, trap.match)
  );

const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/**
 * Strict owner check: the produced owner must equal the expected one
 * (case and surrounding space aside), not merely contain it. An expected
 * null means the summary must not name an owner.
 */
export const ownerCorrect = (expected: ExpectedItem, produced: ProducedItem): boolean => {
  if (!("owner" in expected)) return true;
  if (expected.owner == null) return !norm(produced.owner);
  return norm(produced.owner) === norm(expected.owner);
};

/**
 * Deadline check: the spoken phrase must contain the expected one and,
 * when the key gives `dueResolved`, the resolved date must equal it. An
 * expected null means the summary must not invent a deadline.
 */
export const dueCorrect = (expected: ExpectedItem, produced: ProducedItem): boolean => {
  if (!("dueDate" in expected)) return true;
  if (expected.dueDate == null) return !norm(produced.dueSpoken);
  if (!norm(produced.dueSpoken).includes(norm(expected.dueDate))) return false;
  if (expected.dueResolved) return produced.dueDate === expected.dueResolved;
  return true;
};

/** True when a cited segment is one the key names as evidence. */
export const citationCorrect = (
  expected: ExpectedItem,
  produced: ProducedItem,
  segmentsByIdx: Map<number, Segment>
): boolean =>
  produced.evidence.some((idx) => {
    const segment = segmentsByIdx.get(idx);
    return segment !== undefined && expected.evidenceStartMs.includes(segment.startMs);
  });

/* ---------- support heuristic (hallucination pre-filter) ---------- */

const STOP = new Set(
  (
    "about above after again also because been before being both could does doing done each even every from have having here into just like made make many more most much must need only other over really same should some such than that their them then there these they thing things this those through very want were what when where which while will with would your yours " +
    "meeting summary discussed discuss mentioned mention said says agreed team someone something"
  ).split(" ")
);

const stem = (word: string) =>
  word
    .replace(/'s$/, "")
    .replace(/(?:ing|ed|es|s)$/, (suffix: string, offset: number) => (offset > 3 ? "" : suffix));

export const contentWords = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .filter((word) => word.length >= 4 && !STOP.has(word))
    .map(stem);

/**
 * Share of an item's content words that occur in the segments it cites
 * (plus one neighbour either side, since a reply often carries the
 * subject). Low support does not prove a hallucination: paraphrase and
 * spelled-out numbers lower it too. It only picks the items the judge
 * looks at.
 */
export const supportRatio = (item: ProducedItem, ordered: { idx: number; text: string }[]): number => {
  const words = contentWords(item.text);
  if (!words.length) return 1;

  const position = new Map(ordered.map((segment, i) => [segment.idx, i]));
  const context = new Set<string>();
  for (const idx of item.evidence) {
    const at = position.get(idx);
    if (at === undefined) continue;
    for (const neighbour of ordered.slice(Math.max(0, at - 1), at + 2)) {
      contentWords(neighbour.text).forEach((word) => context.add(word));
    }
  }

  return words.filter((word) => context.has(word)).length / words.length;
};

export const SUPPORT_THRESHOLD = 0.5;
