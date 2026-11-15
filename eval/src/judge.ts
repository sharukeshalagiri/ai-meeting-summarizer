import { containsAll, matchExpected } from "./match";
import { suspectItems, type JudgeVerdict } from "./score";
import type { AnswerKey, ProducedItem, Segment } from "./types";

/**
 * The LLM judge: ONE batched request for the whole run, so its cost is
 * fixed no matter how many cases there are (see docs/decisions/w2-eval.md).
 *
 * It only sees what the deterministic pass could not settle:
 * - expected items with no word-for-word match, next to the unmatched
 *   produced items of the same kind, and
 * - produced items whose words are poorly supported by the lines they
 *   cite.
 * Its answers are validated against the request: a pair or ref that was
 * not offered is ignored.
 */

export interface JudgePair {
  expectedId: string;
  kind: string;
  /** The key's own description of the item: match terms, owner, deadline and the evidence lines. */
  expected: string;
  candidates: { ref: string; text: string }[];
}

export interface JudgeSupport {
  ref: string;
  text: string;
  cited: string[];
}

export interface JudgeCaseRequest {
  caseId: string;
  pairs: JudgePair[];
  support: JudgeSupport[];
}

const line = (segment: Segment) => `${segment.speaker}: ${segment.text}`;

export const buildJudgeRequest = (
  caseId: string,
  key: AnswerKey,
  segments: Segment[],
  produced: ProducedItem[]
): JudgeCaseRequest => {
  const expected = [...key.mustAppear, ...(key.mayAppear ?? [])];
  const assignment = matchExpected(expected, produced);
  const used = new Set(assignment.values());

  const pairs: JudgePair[] = expected
    .filter((item) => !assignment.has(item.id))
    .flatMap((item) => {
      const candidates = produced
        .filter((p) => p.kind === item.kind && !used.has(p.ref))
        // Items that trip a trap are never rescued.
        .filter((p) => !key.mustNotAppear.some((trap) => containsAll(p.text, trap.match)))
        .map((p) => ({ ref: p.ref, text: p.text }));
      if (!candidates.length) return [];

      const evidence = segments
        .filter((s) => item.evidenceStartMs.includes(s.startMs))
        .map(line)
        .join(" / ");
      const parts = [`terms: ${item.match.join(", ")}`];
      if ("owner" in item) parts.push(`owner: ${item.owner ?? "none"}`);
      if ("dueDate" in item) parts.push(`deadline: ${item.dueDate ?? "none"}`);
      parts.push(`said: "${evidence}"`);

      return [{ expectedId: item.id, kind: item.kind, expected: parts.join("; "), candidates }];
    });

  const support: JudgeSupport[] = suspectItems(produced, segments, key).map((item) => ({
    ref: item.ref,
    text: item.text,
    cited: item.evidence.flatMap((idx) => (segments[idx] ? [line(segments[idx])] : [])),
  }));

  return { caseId, pairs, support };
};

export const isEmptyRequest = (requests: JudgeCaseRequest[]) =>
  requests.every((r) => !r.pairs.length && !r.support.length);

export const JUDGE_SYSTEM = `You are a strict evaluator of meeting summaries. You receive, per case:
(1) PAIRS: an expected item (from a hand-written answer key, with the transcript line that says it) and candidate summary items of the same kind.
(2) SUPPORT: summary items with the transcript lines they cite.

Rules for PAIRS. Accept a candidate only if it states the SAME item as the expected one: the same task, decision, question, topic or date, not merely the same subject area. Paraphrase is fine. A candidate that merges two different items, or adds a different task, is not a match. Ignore owner and deadline differences (they are scored separately in code). When unsure, do not match. Return at most one candidate per expected item.

Rules for SUPPORT. An item is UNSUPPORTED if any claim in it (a name, number, date, task, decision or attribution) is not stated in or directly implied by its cited lines. Restating numbers in digits ("eleven" as "11") is supported. When the cited lines are empty, the item is unsupported.

Answer only with the JSON schema. Use the exact caseId, expectedId and ref strings you were given.`;

export const JUDGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    matches: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          caseId: { type: "STRING" },
          expectedId: { type: "STRING" },
          ref: { type: "STRING" },
        },
        required: ["caseId", "expectedId", "ref"],
      },
    },
    unsupported: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { caseId: { type: "STRING" }, ref: { type: "STRING" } },
        required: ["caseId", "ref"],
      },
    },
  },
  required: ["matches", "unsupported"],
} as const;

export const judgePrompt = (requests: JudgeCaseRequest[]): string =>
  requests
    .filter((r) => r.pairs.length || r.support.length)
    .map((r) => {
      const pairs = r.pairs
        .map(
          (p) =>
            `  EXPECTED ${p.expectedId} (${p.kind}): ${p.expected}\n` +
            p.candidates.map((c) => `    CANDIDATE ${c.ref}: ${c.text}`).join("\n")
        )
        .join("\n");
      const support = r.support
        .map((s) => `  ITEM ${s.ref}: ${s.text}\n    CITED: ${s.cited.length ? s.cited.join(" / ") : "(none)"}`)
        .join("\n");
      return `CASE ${r.caseId}\nPAIRS:\n${pairs || "  (none)"}\nSUPPORT:\n${support || "  (none)"}`;
    })
    .join("\n\n");

/**
 * Narrows the judge's JSON to verdicts per case, keeping only pairs and
 * refs that were actually offered.
 */
export const parseJudgeResponse = (
  raw: unknown,
  requests: JudgeCaseRequest[]
): Map<string, JudgeVerdict> => {
  const verdicts = new Map<string, JudgeVerdict>(
    requests.map((r) => [r.caseId, { matches: [], unsupported: [] }])
  );
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const byCase = new Map(requests.map((r) => [r.caseId, r]));

  for (const entry of Array.isArray(body.matches) ? body.matches : []) {
    const { caseId, expectedId, ref } = (entry ?? {}) as Record<string, unknown>;
    const request = typeof caseId === "string" ? byCase.get(caseId) : undefined;
    const pair = request?.pairs.find((p) => p.expectedId === expectedId);
    if (!pair || !pair.candidates.some((c) => c.ref === ref)) continue;
    const verdict = verdicts.get(caseId as string)!;
    if (verdict.matches.some((m) => m.expectedId === expectedId)) continue;
    verdict.matches.push({ expectedId: expectedId as string, ref: ref as string });
  }

  for (const entry of Array.isArray(body.unsupported) ? body.unsupported : []) {
    const { caseId, ref } = (entry ?? {}) as Record<string, unknown>;
    const request = typeof caseId === "string" ? byCase.get(caseId) : undefined;
    if (!request?.support.some((s) => s.ref === ref)) continue;
    const verdict = verdicts.get(caseId as string)!;
    if (!verdict.unsupported.includes(ref as string)) verdict.unsupported.push(ref as string);
  }

  return verdicts;
};
