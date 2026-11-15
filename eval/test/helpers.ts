import fs from "node:fs";
import path from "node:path";
import { FIXTURE_DIR } from "../src/cases";
import type { AnswerKey, ProducedItem, Segment } from "../src/types";

export const fixture = (name: string): { key: AnswerKey; segments: Segment[] } => {
  const key = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.expected.json`), "utf8")) as AnswerKey;
  const segments = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, key.transcript), "utf8")) as Segment[];
  return { key, segments };
};

/** idx (array position) of the segment starting at `ms`. */
export const idxAt = (segments: Segment[], ms: number): number => {
  const idx = segments.findIndex((s) => s.startMs === ms);
  if (idx < 0) throw new Error(`no segment at ${ms}`);
  return idx;
};

export const item = (partial: Partial<ProducedItem> & Pick<ProducedItem, "kind" | "text">): ProducedItem => ({
  ref: partial.ref ?? `${partial.kind}[${Math.random().toString(36).slice(2, 7)}]`,
  evidence: [],
  ...partial,
});
