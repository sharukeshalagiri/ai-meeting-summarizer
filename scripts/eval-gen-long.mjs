#!/usr/bin/env node
/**
 * Builds the synthetic 90-minute case (transcript + answer key) from the
 * small committed template in eval/cases/long-90min/template.json, so the
 * repo carries a ~5 KB template instead of a large transcript.
 *
 *   node scripts/eval-gen-long.mjs            writes eval/.generated/long-90min{,.expected}.json
 *
 * Deterministic: a seeded PRNG picks speakers, areas and filler lines, so
 * the same template always yields the same segments and evidence times.
 * Planted items (tasks, decisions, a question, a date, traps) are inserted
 * at fixed minutes; the answer key is derived from where they land.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE_PATH = path.join(root, "eval/cases/long-90min/template.json");
export const OUTPUT_DIR = path.join(root, "eval/.generated");

/** mulberry32: tiny, fast and good enough for picking filler lines. */
const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Speaking time from word count, same rule as the hand-built fixtures. */
const durationOf = (text) => Math.max(2400, Math.round((text.split(/\s+/).length * 380) / 200) * 200);

export const generateLongCase = (template) => {
  const random = prng(template.seed);
  const pick = (list) => list[Math.floor(random() * list.length)];

  const segments = [];
  let t = 0;
  const say = (speaker, text) => {
    const segment = { speaker, text, startMs: t, endMs: t + durationOf(text) };
    segments.push(segment);
    // 0.4 s gap plus a pause of up to 3 s between turns.
    t = segment.endMs + 400 + Math.round((random() * 3000) / 200) * 200;
    return segment;
  };

  const mustAppear = [];
  const mustNotAppear = [...template.traps];
  const planted = [...template.planted].sort((a, b) => a.atMinute - b.atMinute);
  const closingMs = template.closing.reduce((sum, [, text]) => sum + durationOf(text) + 2000, 0);

  template.opening.forEach(([speaker, text]) => say(speaker, text));

  let previous = segments.at(-1).speaker;
  while (t < template.targetMs - closingMs) {
    if (planted.length && planted[0].atMinute * 60_000 <= t) {
      const item = planted.shift();
      const said = item.lines.map(([speaker, text]) => say(speaker, text));
      previous = said.at(-1).speaker;

      if (item.kind === "trap") {
        mustNotAppear.push({ id: item.id, kind: item.trapKind, match: item.match, reason: item.reason });
      } else {
        const { atMinute: _m, lines: _l, evidence, ...key } = item;
        mustAppear.push({ ...key, evidenceStartMs: [said[evidence].startMs] });
      }
      continue;
    }

    const speaker = pick(template.speakers.filter((s) => s !== previous));
    const area = pick(template.areas);
    const count = 4 + Math.floor(random() * 2);
    const statements = [];
    while (statements.length < count) {
      const statement = pick(template.statements);
      if (!statements.includes(statement)) statements.push(statement);
    }
    say(speaker, `${pick(template.openers).replace("{area}", area)} ${statements.join(" ")}`);
    previous = speaker;

    if (random() < 0.15) {
      const replier = pick(template.speakers.filter((s) => s !== previous));
      say(replier, pick(template.replies));
      previous = replier;
    }
  }

  template.closing.forEach(([speaker, text]) => say(speaker, text));

  const key = {
    transcript: "long-90min.json",
    mode: template.mode,
    description: template.description,
    mustAppear,
    mustNotAppear,
  };

  return { segments, key };
};

export const loadTemplate = () => JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { segments, key } = generateLongCase(loadTemplate());
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, "long-90min.json"), JSON.stringify(segments, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, "long-90min.expected.json"), JSON.stringify(key, null, 2));
  const words = segments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
  console.log(
    `long-90min: ${segments.length} segments, ${words} words, ${(segments.at(-1).endMs / 60000).toFixed(1)} min -> ${path.relative(root, OUTPUT_DIR)}`
  );
}
