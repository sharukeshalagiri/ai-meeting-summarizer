import {
  SUPPORT_THRESHOLD,
  citationCorrect,
  containsAll,
  dueCorrect,
  matchExpected,
  ownerCorrect,
  supportRatio,
  trapHits,
} from "./match";
import type { AnswerKey, ExpectedItem, ProducedItem, Segment } from "./types";

/**
 * Scores one transcript case's summary against its answer key.
 * Pure: segments carry idx = array position (the harness numbers them
 * that way), and everything the judge said arrives as `verdict`.
 */

export interface JudgeVerdict {
  /** Pairs the judge accepted as the same item despite different words. */
  matches: { expectedId: string; ref: string }[];
  /** Produced refs the judge found unsupported by their cited lines. */
  unsupported: string[];
}

export interface ItemResult {
  id: string;
  kind: string;
  found: boolean;
  ref?: string;
  ownerOk?: boolean;
  dueOk?: boolean;
  citationOk?: boolean;
}

export interface SummaryScore {
  mustAppear: { total: number; found: number; items: ItemResult[] };
  tasks: { expected: number; foundText: number; foundFull: number; produced: number; truePositive: number };
  dates: { total: number; correct: number };
  exam: { total: number; found: number };
  traps: { total: number; hit: string[] };
  counts: { kind: string; expected: number; actual: number }[];
  hallucination: { produced: number; trapItems: number; judgedUnsupported: number; suspects: number };
  citations: { checked: number; correct: number };
  tldr: { words: number; sentences: number };
  /** False when no judge verdict was available for this case. */
  judged: boolean;
}

const DATED_KINDS = new Set(["actionItem", "homework", "date"]);

const countWords = (text: string) => (text.match(/\S+/g) ?? []).length;
const countSentences = (text: string) => (text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?\s][^.!?]*$/g) ?? []).length;

/** Produced items the support heuristic flags for the judge. */
export const suspectItems = (produced: ProducedItem[], segments: Segment[], key: AnswerKey): ProducedItem[] => {
  const ordered = segments.map((segment, idx) => ({ idx, text: segment.text }));
  return produced.filter(
    (item) =>
      !trapHits(item, key.mustNotAppear).length &&
      (item.evidence.length === 0 || supportRatio(item, ordered) < SUPPORT_THRESHOLD)
  );
};

export const scoreSummary = (input: {
  key: AnswerKey;
  segments: Segment[];
  produced: ProducedItem[];
  tldr: string;
  verdict?: JudgeVerdict;
}): SummaryScore => {
  const { key, segments, produced, verdict } = input;
  const byIdx = new Map(segments.map((segment, idx) => [idx, segment]));
  const byRef = new Map(produced.map((item) => [item.ref, item]));

  const assignment = matchExpected(key.mustAppear, produced, verdict?.matches);
  const mayAssignment = matchExpected(
    key.mayAppear ?? [],
    produced.filter((item) => ![...assignment.values()].includes(item.ref)),
    verdict?.matches
  );

  const results: ItemResult[] = key.mustAppear.map((item) => {
    const ref = assignment.get(item.id);
    const hit = ref ? byRef.get(ref) : undefined;
    if (!hit) return { id: item.id, kind: item.kind, found: false };
    return {
      id: item.id,
      kind: item.kind,
      found: true,
      ref,
      ownerOk: ownerCorrect(item, hit),
      dueOk: dueCorrect(item, hit),
      citationOk: citationCorrect(item, hit, byIdx),
    };
  });

  const resultOf = (item: ExpectedItem) => results.find((r) => r.id === item.id)!;
  const tasks = key.mustAppear.filter((item) => item.kind === "actionItem");
  const producedTasks = produced.filter((item) => item.kind === "actionItem");
  const matchedRefs = new Set([...assignment.values(), ...mayAssignment.values()]);

  const dated = key.mustAppear.filter((item) => DATED_KINDS.has(item.kind) && "dueDate" in item);
  const exam = key.mustAppear.filter((item) => item.kind === "examTopic");

  const trapItems = produced.filter((item) => trapHits(item, key.mustNotAppear).length > 0);
  const hitTraps = key.mustNotAppear.filter((trap) =>
    produced.some((item) => (trap.kind === "any" || trap.kind === item.kind) && containsAll(item.text, trap.match))
  );

  const unsupported = new Set(verdict?.unsupported ?? []);
  const trapRefs = new Set(trapItems.map((item) => item.ref));
  const judgedUnsupported = [...unsupported].filter((ref) => byRef.has(ref) && !trapRefs.has(ref)).length;

  const counts = Object.entries(key.counts ?? {}).flatMap(([kind, expected]) => {
    const actual = produced.filter((item) => item.kind === kind).length;
    return actual === expected ? [] : [{ kind, expected, actual }];
  });

  const found = results.filter((r) => r.found);

  return {
    mustAppear: { total: results.length, found: found.length, items: results },
    tasks: {
      expected: tasks.length,
      foundText: tasks.filter((t) => resultOf(t).found).length,
      foundFull: tasks.filter((t) => {
        const r = resultOf(t);
        return r.found && r.ownerOk && r.dueOk;
      }).length,
      produced: producedTasks.length,
      truePositive: producedTasks.filter((item) => matchedRefs.has(item.ref)).length,
    },
    dates: {
      total: dated.length,
      correct: dated.filter((item) => {
        const r = resultOf(item);
        return r.found && r.dueOk;
      }).length,
    },
    exam: { total: exam.length, found: exam.filter((item) => resultOf(item).found).length },
    traps: { total: key.mustNotAppear.length, hit: hitTraps.map((trap) => trap.id) },
    counts,
    hallucination: {
      produced: produced.length,
      trapItems: trapItems.length,
      judgedUnsupported,
      suspects: suspectItems(produced, segments, key).length,
    },
    citations: { checked: found.length, correct: found.filter((r) => r.citationOk).length },
    tldr: { words: countWords(input.tldr), sentences: countSentences(input.tldr) },
    judged: verdict !== undefined,
  };
};
