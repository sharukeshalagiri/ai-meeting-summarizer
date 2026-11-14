import fs from "fs";
import path from "path";
import type { PipelineSegment } from "../../../src/services/summary.service";
import {
  normalizeModeSetting,
  type ModeSetting,
  type SummaryV2,
} from "../../../src/types/summary";

/**
 * Loads the synthetic fixtures (owned by w2-eval; read-only here) and
 * scores a v2 summary against their answer keys, following the matching
 * rules in fixtures/transcripts/README.md.
 *
 * Fixture modes are lowercase ("project") and expected evidence is a
 * segment startMs; both are mapped here: modes to Meeting.mode values,
 * startMs to the idx the segment gets in the test.
 */

export const FIXTURE_DIR = path.resolve(__dirname, "../../../../fixtures/transcripts");

export interface FixtureSegment {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface ExpectedItem {
  id: string;
  kind: string;
  match: string[];
  owner?: string | null;
  dueDate?: string | null;
  evidenceStartMs: number[];
}

export interface ForbiddenItem {
  id: string;
  kind: string;
  match: string[];
  reason: string;
}

export interface Fixture {
  name: string;
  mode: ModeSetting;
  segments: PipelineSegment[];
  mustAppear: ExpectedItem[];
  mustNotAppear: ForbiddenItem[];
  /** startMs -> idx for this load. */
  idxByStart: Map<number, number>;
}

/**
 * Loads `<name>.json` and its answer key. `idxFor` assigns idx values:
 * dense (i) like an upload, or sparse (e.g. 1000 + i) like live capture,
 * to prove nothing relies on array positions.
 */
export const loadFixture = (
  name: string,
  idxFor: (position: number) => number = (position) => position
): Fixture => {
  const read = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));

  const raw: FixtureSegment[] = read(`${name}.json`);
  const key = read(`${name}.expected.json`);

  const segments = raw.map((segment, position) => ({
    idx: idxFor(position),
    speaker: segment.speaker,
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
  }));

  return {
    name,
    mode: normalizeModeSetting(key.mode) ?? "GENERAL",
    segments,
    mustAppear: key.mustAppear,
    mustNotAppear: key.mustNotAppear,
    idxByStart: new Map(segments.map((segment) => [segment.startMs, segment.idx])),
  };
};

/** A produced item, flattened for matching. */
export interface ProducedItem {
  kind: string;
  text: string;
  owner?: string | null;
  dueSpoken?: string | null;
  dueDate?: string | null;
  evidence: { idx: number; startMs: number }[];
}

/** Every item in a summary, tagged with the answer-key kind. */
export const flatten = (summary: SummaryV2): ProducedItem[] => {
  const items: ProducedItem[] = [];
  const lecture = summary.sections.lecture;

  for (const item of summary.decisions) items.push({ kind: "decision", text: item.text, evidence: item.evidence });
  for (const item of summary.actionItems) {
    items.push({
      kind: "actionItem",
      text: item.task,
      owner: item.owner,
      dueSpoken: item.dueSpoken,
      dueDate: item.dueDate,
      evidence: item.evidence,
    });
  }
  for (const item of summary.openQuestions) items.push({ kind: "openQuestion", text: item.text, evidence: item.evidence });
  for (const item of summary.dates) items.push({ kind: "date", text: `${item.spoken} ${item.description}`, evidence: item.evidence });
  for (const item of summary.keyPoints) items.push({ kind: "keyPoint", text: item.text, evidence: item.evidence });
  for (const item of summary.whoSaidWhat) items.push({ kind: "whoSaidWhat", text: item.text, evidence: item.evidence });
  for (const item of summary.glossary) items.push({ kind: "glossary", text: `${item.term} ${item.definition}`, evidence: item.evidence });
  for (const item of summary.nextSessionPrep) items.push({ kind: "prep", text: item.text, evidence: item.evidence });

  if (lecture) {
    for (const item of lecture.examQuestions.flaggedByLecturer) {
      items.push({ kind: "examTopic", text: `${item.question} ${item.reason}`, evidence: item.evidence });
    }
    for (const item of lecture.examQuestions.likely) {
      items.push({ kind: "likelyExamTopic", text: `${item.question} ${item.reason}`, evidence: item.evidence });
    }
    for (const item of lecture.definitions) {
      items.push({ kind: "definition", text: `${item.term} ${item.definition}`, evidence: item.evidence });
    }
    for (const item of lecture.assignments) {
      items.push({
        kind: "homework",
        text: item.task,
        dueSpoken: item.dueSpoken,
        dueDate: item.dueDate,
        evidence: item.evidence,
      });
    }
    for (const item of lecture.outline) items.push({ kind: "outline", text: item.text, evidence: item.evidence });
    for (const item of lecture.formulas) items.push({ kind: "formula", text: `${item.expression} ${item.meaning}`, evidence: item.evidence });
    for (const item of lecture.studyChecklist) items.push({ kind: "checklist", text: item.text, evidence: item.evidence });
  }

  const project = summary.sections.project;
  if (project) {
    for (const person of project.people) {
      for (const item of [...person.done, ...person.next, ...person.blockers]) {
        items.push({ kind: "projectStatus", text: `${person.name} ${item.text}`, evidence: item.evidence });
      }
    }
    for (const item of project.risks) items.push({ kind: "risk", text: item.text, evidence: item.evidence });
  }

  return items;
};

const contains = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase());

export interface Evaluation {
  found: string[];
  missing: string[];
  /** Found, but the citation misses every expected segment. */
  wrongEvidence: string[];
  /** Found, but owner or due date differ from the key. */
  wrongDetails: string[];
  /** mustNotAppear entries that appeared. */
  violations: string[];
}

/** Scores a summary against a fixture's answer key. */
export const evaluate = (summary: SummaryV2, fixture: Fixture): Evaluation => {
  const items = flatten(summary);
  const result: Evaluation = { found: [], missing: [], wrongEvidence: [], wrongDetails: [], violations: [] };

  for (const expected of fixture.mustAppear) {
    const candidates = items.filter(
      (item) => item.kind === expected.kind && expected.match.every((term) => contains(item.text, term))
    );

    if (!candidates.length) {
      result.missing.push(expected.id);
      continue;
    }

    result.found.push(expected.id);

    const cited = candidates.some((item) =>
      item.evidence.some((entry) => expected.evidenceStartMs.includes(entry.startMs))
    );
    if (!cited) result.wrongEvidence.push(expected.id);

    if ("owner" in expected || "dueDate" in expected) {
      const detailsOk = candidates.some((item) => {
        const ownerOk =
          !("owner" in expected) ||
          (expected.owner === null ? !item.owner : !!item.owner && contains(item.owner, expected.owner ?? ""));
        const dueOk =
          !("dueDate" in expected) ||
          (expected.dueDate === null
            ? !item.dueSpoken
            : !!item.dueSpoken && contains(item.dueSpoken, expected.dueDate ?? ""));
        return ownerOk && dueOk;
      });
      if (!detailsOk) result.wrongDetails.push(expected.id);
    }
  }

  for (const forbidden of fixture.mustNotAppear) {
    const hit = items.some(
      (item) =>
        (forbidden.kind === "any" || item.kind === forbidden.kind) &&
        forbidden.match.every((term) => contains(item.text, term))
    );
    if (hit || (forbidden.kind === "any" && forbidden.match.every((term) => contains(summary.tldr, term)))) {
      result.violations.push(forbidden.id);
    }
  }

  return result;
};
