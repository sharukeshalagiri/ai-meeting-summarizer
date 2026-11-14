import { containsAll } from "./match";
import type { AnswerKey, ExpectedItem, ForbiddenItem } from "./types";

/**
 * Turns the user's Correction rows (w1-sum review: accept / edit /
 * reject an action item; a mode change) into PROPOSED answer-key edits.
 * Nothing is written here: the CLI prints the proposals and writes only
 * with --write, after the user has read them.
 */

export interface CorrectionRow {
  id: string;
  kind: string;
  targetId?: string | null;
  before: unknown;
  after: unknown;
  createdAt?: Date | string;
}

export type Proposal =
  | { type: "addMustAppear"; correction: string; item: ExpectedItem }
  | { type: "updateMustAppear"; correction: string; id: string; item: ExpectedItem }
  | { type: "addMustNotAppear"; correction: string; item: ForbiddenItem }
  | { type: "setMode"; correction: string; from: string; to: string }
  | { type: "ignored"; correction: string; why: string };

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

const STOP = new Set("the a an to and or of for on in by with from this that will i'll we'll our your their".split(" "));

/** The two longest words of a task: short, distinctive match terms. */
export const matchTerms = (task: string): string[] =>
  [...new Set(task.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])]
    .filter((word) => word.length >= 4 && !STOP.has(word))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);

const slug = (terms: string[]) => terms.join("-").replace(/[^a-z0-9-]/g, "") || "item";

const isoDay = (value: unknown): string | null => {
  const s = typeof value === "string" ? value : value instanceof Date ? value.toISOString() : null;
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

const evidenceMs = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const ms = obj(entry).startMs;
        return typeof ms === "number" ? [ms] : [];
      })
    : [];

const MODE_NAMES: Record<string, string> = {
  PROJECT: "project",
  LECTURE: "lecture",
  INTERVIEW: "interview",
  ONE_ON_ONE: "one-on-one",
  GENERAL: "general",
};

export const proposeFromCorrections = (key: AnswerKey, rows: CorrectionRow[]): Proposal[] => {
  const proposals: Proposal[] = [];
  const taken = new Set([...key.mustAppear, ...key.mustNotAppear].map((i) => i.id));
  const uniqueId = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };

  for (const row of rows) {
    const before = obj(row.before);
    const after = obj(row.after);

    if (row.kind === "MEETING_MODE") {
      const to = MODE_NAMES[String(after.mode)];
      if (to && to !== key.mode) proposals.push({ type: "setMode", correction: row.id, from: key.mode, to });
      else proposals.push({ type: "ignored", correction: row.id, why: `mode ${String(after.mode)} needs no key change` });
      continue;
    }

    if (row.kind !== "ACTION_ITEM") {
      proposals.push({ type: "ignored", correction: row.id, why: `${row.kind} corrections have no answer-key mapping yet` });
      continue;
    }

    const action = String(after.action ?? "");
    const task = text(after.task) ?? text(before.task);
    if (!task) {
      proposals.push({ type: "ignored", correction: row.id, why: "no task text" });
      continue;
    }
    const terms = matchTerms(task);
    if (!terms.length) {
      proposals.push({ type: "ignored", correction: row.id, why: `no distinctive words in "${task}"` });
      continue;
    }

    if (action === "reject") {
      proposals.push({
        type: "addMustNotAppear",
        correction: row.id,
        item: { id: uniqueId(`rejected-${slug(terms)}`), kind: "actionItem", match: terms, reason: `Rejected in review (correction ${row.id}): "${task}".` },
      });
      continue;
    }

    if (action !== "accept" && action !== "edit") {
      proposals.push({ type: "ignored", correction: row.id, why: `unknown review action "${action}"` });
      continue;
    }

    const pick = (field: string) => (field in after ? after[field] : before[field]);
    const item: ExpectedItem = {
      id: "",
      kind: "actionItem",
      match: terms,
      owner: text(pick("owner")),
      dueDate: text(pick("dueSpoken")),
      ...(isoDay(pick("dueDate")) ? { dueResolved: isoDay(pick("dueDate")) } : {}),
      evidenceStartMs: evidenceMs(before.evidence),
    };

    const existing = key.mustAppear.find((e) => e.kind === "actionItem" && containsAll(task, e.match));
    if (existing) {
      proposals.push({ type: "updateMustAppear", correction: row.id, id: existing.id, item: { ...item, id: existing.id, match: existing.match } });
    } else {
      proposals.push({ type: "addMustAppear", correction: row.id, item: { ...item, id: uniqueId(`task-${slug(terms)}`) } });
    }
  }

  return proposals;
};

export const applyProposals = (key: AnswerKey, proposals: Proposal[]): AnswerKey => {
  const next: AnswerKey = { ...key, mustAppear: [...key.mustAppear], mustNotAppear: [...key.mustNotAppear] };
  for (const p of proposals) {
    if (p.type === "addMustAppear") next.mustAppear.push(p.item);
    if (p.type === "updateMustAppear") next.mustAppear = next.mustAppear.map((e) => (e.id === p.id ? p.item : e));
    if (p.type === "addMustNotAppear") next.mustNotAppear.push(p.item);
    if (p.type === "setMode") next.mode = p.to;
  }
  return next;
};

export const describeProposal = (p: Proposal): string => {
  switch (p.type) {
    case "addMustAppear":
      return `+ mustAppear ${p.item.id}: match [${p.item.match.join(", ")}], owner ${p.item.owner ?? "none"}, due ${p.item.dueDate ?? "none"}${p.item.dueResolved ? ` (${p.item.dueResolved})` : ""}`;
    case "updateMustAppear":
      return `~ mustAppear ${p.id}: owner ${p.item.owner ?? "none"}, due ${p.item.dueDate ?? "none"}${p.item.dueResolved ? ` (${p.item.dueResolved})` : ""}`;
    case "addMustNotAppear":
      return `+ mustNotAppear ${p.item.id}: match [${p.item.match.join(", ")}]`;
    case "setMode":
      return `~ mode ${p.from} -> ${p.to}`;
    case "ignored":
      return `  (ignored ${p.correction}: ${p.why})`;
  }
};
