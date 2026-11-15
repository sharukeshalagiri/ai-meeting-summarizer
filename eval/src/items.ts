import type { SummaryV2 } from "../../backend/src/types/summary";
import type { ProducedItem } from "./types";

/**
 * Flattens a v2 summary into one list of items with an answer-key kind.
 *
 * Which summary field answers which key kind (README "Kinds"):
 *   actionItem    actionItems
 *   decision      decisions
 *   openQuestion  openQuestions
 *   date          dates
 *   examTopic     sections.lecture.examQuestions.flaggedByLecturer
 *   definition    glossary + sections.lecture.definitions
 *   homework      sections.lecture.assignments
 *   qa / concern / strength / followUp / struggledWith   sections.interview.*
 *   feedback      sections.oneOnOne.feedback
 * Everything else (key points, likely exam questions, commitments, ...)
 * is kind "other": it still counts for "any" traps and hallucination.
 */

type Node = Record<string, unknown>;

const strings = (node: unknown, into: string[] = []): string[] => {
  if (typeof node === "string") into.push(node);
  else if (Array.isArray(node)) node.forEach((entry) => strings(entry, into));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      // Not content: ids, review flags, and fields copied from segments.
      if (["evidence", "confidence", "needsReview", "priority", "dueDate", "date"].includes(key)) continue;
      strings(value, into);
    }
  }
  return into;
};

const evidenceOf = (node: Node): number[] =>
  Array.isArray(node.evidence)
    ? node.evidence.flatMap((entry) => {
        if (typeof entry === "number") return [entry];
        const idx = (entry as Node | null)?.idx;
        return typeof idx === "number" ? [idx] : [];
      })
    : [];

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const list = (value: unknown): Node[] =>
  Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Node[]) : [];

export const flattenSummary = (summary: SummaryV2): ProducedItem[] => {
  const out: ProducedItem[] = [];
  const seen = new Set<Node>();

  const add = (ref: string, kind: string, node: Node, extra: Partial<ProducedItem> = {}) => {
    seen.add(node);
    out.push({ ref, kind, text: strings(node).join(" — "), evidence: evidenceOf(node), ...extra });
  };

  const each = (path: string, kind: string, value: unknown, extra?: (n: Node) => Partial<ProducedItem>) =>
    list(value).forEach((node, i) => add(`${path}[${i}]`, kind, node, extra?.(node)));

  const s = summary as unknown as Node;
  const sections = (s.sections ?? {}) as Node;
  const lecture = (sections.lecture ?? {}) as Node;
  const exam = (lecture.examQuestions ?? {}) as Node;
  const interview = (sections.interview ?? {}) as Node;
  const oneOnOne = (sections.oneOnOne ?? {}) as Node;

  each("actionItems", "actionItem", s.actionItems, (n) => ({
    owner: str(n.owner),
    dueSpoken: str(n.dueSpoken),
    dueDate: str(n.dueDate),
  }));
  each("decisions", "decision", s.decisions);
  each("openQuestions", "openQuestion", s.openQuestions);
  each("dates", "date", s.dates, (n) => ({ dueSpoken: str(n.spoken), dueDate: str(n.date) }));
  each("glossary", "definition", s.glossary);
  each("lecture.definitions", "definition", lecture.definitions);
  each("lecture.examQuestions.flaggedByLecturer", "examTopic", exam.flaggedByLecturer);
  each("lecture.assignments", "homework", lecture.assignments, (n) => ({
    dueSpoken: str(n.dueSpoken),
    dueDate: str(n.dueDate),
  }));
  each("interview.qa", "qa", interview.qa);
  each("interview.concerns", "concern", interview.concerns);
  each("interview.strengths", "strength", interview.strengths);
  each("interview.followUps", "followUp", interview.followUps);
  each("interview.struggledWith", "struggledWith", interview.struggledWith);
  each("oneOnOne.feedback", "feedback", oneOnOne.feedback);

  // Every other evidence-bearing object anywhere in the summary.
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, `${path}[${i}]`));
    } else if (node && typeof node === "object") {
      const obj = node as Node;
      if (Array.isArray(obj.evidence) && !seen.has(obj)) {
        add(path, "other", obj);
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key !== "evidence") walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  for (const key of ["keyPoints", "whoSaidWhat", "nextSessionPrep", "sections"]) walk(s[key], key);

  return out;
};
