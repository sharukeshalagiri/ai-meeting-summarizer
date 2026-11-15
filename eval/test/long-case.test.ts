import { describe, expect, it } from "vitest";
import { generateLongCase, loadTemplate } from "../../scripts/eval-gen-long.mjs";
import { estimateSummaryCalls, toPipelineSegments } from "../src/run";
import { chunkByTokenBudget } from "../../backend/src/services/summary.service";
import type { AnswerKey, Segment } from "../src/types";

/**
 * The 90-minute case is generated, not committed, so these checks play
 * the role backend/test/fixtures.test.ts plays for committed fixtures,
 * plus the call arithmetic the Gemini budget relies on.
 */

const { segments, key } = generateLongCase(loadTemplate()) as { segments: Segment[]; key: AnswerKey };

describe("long-90min generator", () => {
  it("is deterministic", () => {
    expect(generateLongCase(loadTemplate())).toEqual({ segments, key });
  });

  it("lasts about 90 minutes with ordered, non-overlapping segments", () => {
    expect(segments.at(-1)!.endMs).toBeGreaterThan(88 * 60_000);
    expect(segments.at(-1)!.endMs).toBeLessThan(92 * 60_000);
    segments.forEach((s, i) => {
      expect(s.endMs).toBeGreaterThan(s.startMs);
      if (i) expect(s.startMs).toBeGreaterThanOrEqual(segments[i - 1].endMs);
    });
  });

  it("costs exactly 6 Gemini requests: 2 CLEAN, 2 EXTRACT, REDUCE, VERIFY", () => {
    const pipeline = toPipelineSegments(segments);
    expect(segments.length).toBeLessThanOrEqual(300); // two CLEAN batches of 150
    expect(chunkByTokenBudget(pipeline, 12_000)).toHaveLength(2);
    expect(estimateSummaryCalls(pipeline)).toBe(6);
  });

  it("plants items in both halves, backed by their evidence", () => {
    const half = segments.at(-1)!.endMs / 2;
    expect(key.mustAppear.some((i) => i.evidenceStartMs[0] < half)).toBe(true);
    expect(key.mustAppear.some((i) => i.evidenceStartMs[0] > half)).toBe(true);
    expect(key.mustAppear.filter((i) => i.kind === "actionItem")).toHaveLength(5);

    for (const item of key.mustAppear) {
      const evidence = segments.find((s) => s.startMs === item.evidenceStartMs[0]);
      expect(evidence, item.id).toBeDefined();
      const text = evidence!.text.toLowerCase();
      item.match.forEach((term) => expect(text, item.id).toContain(term.toLowerCase()));
      if (item.owner) expect(segments.map((s) => s.speaker)).toContain(item.owner);
      if (item.dueDate) expect(text).toContain(item.dueDate.toLowerCase());
    }
  });

  it("filler never contains a match term or trap, so only planted lines can satisfy the key", () => {
    const planted = new Set(key.mustAppear.flatMap((i) => i.evidenceStartMs));
    const terms = [...key.mustAppear, ...key.mustNotAppear].flatMap((i) => i.match.map((t) => t.toLowerCase()));
    const counts = terms.map((term) => segments.filter((s) => s.text.toLowerCase().includes(term)).length);
    // Each term occurs only in its planted exchange (at most its two lines).
    counts.forEach((n, i) => expect(n, terms[i]).toBeGreaterThan(0));
    counts.forEach((n, i) => expect(n, terms[i]).toBeLessThanOrEqual(2));
    expect(planted.size).toBe(key.mustAppear.length);
  });
});
