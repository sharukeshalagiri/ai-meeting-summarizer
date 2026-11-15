import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateLongCase, loadTemplate } from "../../scripts/eval-gen-long.mjs";
import type { AnswerKey, AudioReference, CaseEntry, LoadedCase, Segment } from "./types";

/**
 * Finds and loads evaluation cases:
 * - synthetic: committed transcripts + keys in fixtures/transcripts
 * - generated: built in memory by a deterministic generator (long-90min)
 * - ami: eval/data/ami/<meeting>/ from `npm run eval:fetch-ami` (gitignored)
 * - own: eval/cases/own/<slug>/case.json from `npm run eval:new-case`
 *   (gitignored: real recordings never enter the repo)
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_DIR = path.join(ROOT, "fixtures/transcripts");
export const EVAL_DIR = path.join(ROOT, "eval");
export const AMI_DIR = path.join(EVAL_DIR, "data/ami");
export const OWN_DIR = path.join(EVAL_DIR, "cases/own");

interface CaseIndex {
  defaults: { meetingStart: string; timezone: string };
  cases: CaseEntry[];
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

/** Committed cases plus any own-recording cases found on disk. */
export const listCases = (): CaseEntry[] => {
  const index = readJson<CaseIndex>(path.join(EVAL_DIR, "cases/index.json"));
  const withDefaults = (entry: CaseEntry, i: number): CaseEntry => ({
    meetingStart: index.defaults.meetingStart,
    timezone: index.defaults.timezone,
    priority: i,
    ...entry,
  });

  const own = fs.existsSync(OWN_DIR)
    ? fs
        .readdirSync(OWN_DIR)
        .filter((slug) => fs.existsSync(path.join(OWN_DIR, slug, "case.json")))
        .map((slug) => ({ ...readJson<CaseEntry>(path.join(OWN_DIR, slug, "case.json")), id: `own-${slug}`, type: "own" as const }))
    : [];

  return [...index.cases, ...own].map(withDefaults);
};

/** `--cases a,b` (ids), `--cases smoke`, `--cases synthetic|ami|own`, or every case. */
export const selectCases = (all: CaseEntry[], filter?: string): CaseEntry[] => {
  if (!filter) return all;
  const wanted = filter.split(",").map((s) => s.trim()).filter(Boolean);
  const picked = all.filter(
    (entry) =>
      wanted.includes(entry.id) ||
      (wanted.includes("smoke") && entry.smoke) ||
      wanted.includes(entry.type) ||
      (wanted.includes("transcript") && (entry.type === "synthetic" || entry.type === "generated"))
  );
  const unknown = wanted.filter(
    (w) => !["smoke", "synthetic", "generated", "ami", "own", "transcript"].includes(w) && !all.some((e) => e.id === w)
  );
  if (unknown.length) throw new Error(`Unknown case(s): ${unknown.join(", ")}. Known: ${all.map((e) => e.id).join(", ")}`);
  return picked;
};

const spanOf = (segments: Segment[]) =>
  segments.length ? segments[segments.length - 1].endMs - segments[0].startMs : 0;

/** Loads a case, or explains why it cannot run (missing data). */
export const loadCase = (entry: CaseEntry): LoadedCase | { missing: string } => {
  if (entry.type === "synthetic") {
    const key = readJson<AnswerKey>(path.join(FIXTURE_DIR, entry.key!));
    const segments = readJson<Segment[]>(path.join(FIXTURE_DIR, key.transcript));
    return { entry, key, segments, durationMs: spanOf(segments) };
  }

  if (entry.type === "generated") {
    const { segments, key } = generateLongCase(loadTemplate()) as { segments: Segment[]; key: AnswerKey };
    return { entry, key, segments, durationMs: spanOf(segments) };
  }

  const dir = entry.type === "ami" ? path.join(AMI_DIR, entry.meeting!) : path.join(OWN_DIR, entry.id.replace(/^own-/, ""));
  const audioPath = path.join(dir, entry.type === "ami" ? "stereo.wav" : "audio.wav");
  if (!fs.existsSync(audioPath)) {
    return {
      missing:
        entry.type === "ami"
          ? `no ${path.relative(ROOT, audioPath)}; run npm run eval:fetch-ami`
          : `no ${path.relative(ROOT, audioPath)}; put the recording there (stereo, left = you)`,
    };
  }

  const referencePath = path.join(dir, "reference.json");
  const reference = fs.existsSync(referencePath) ? readJson<AudioReference>(referencePath) : undefined;
  const keyPath = path.join(dir, "expected.json");
  const key = fs.existsSync(keyPath) ? readJson<AnswerKey>(keyPath) : undefined;
  const lastWord = reference?.words[reference.words.length - 1];

  return { entry, audioPath, reference, key, durationMs: lastWord?.endMs ?? 0 };
};
