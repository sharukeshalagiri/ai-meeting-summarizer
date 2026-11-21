#!/usr/bin/env node
/**
 * The README's accuracy table, generated from the latest evaluation
 * report (w5-demo). Never typed by hand.
 *
 *   npm run readme:accuracy            rewrite the block in README.md
 *   npm run readme:accuracy -- --check exit 1 if the block is not the
 *                                      generator's output for the report it names
 *
 * The block sits between `<!-- accuracy:start -->` and
 * `<!-- accuracy:end -->` and names its source report. Without any
 * report in eval/reports/ (the baseline has not run yet), it says "Not
 * yet measured" and shows no number at all.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPORTS_DIR = path.join(ROOT, "eval", "reports");
export const README = path.join(ROOT, "README.md");

export const START = "<!-- accuracy:start -->";
export const END = "<!-- accuracy:end -->";

/** The headline metrics, in eval/src/report.ts order (a test keeps them equal). */
export const HEADLINE = [
  { name: "taskRecallFull", label: "Task recall (text + owner + date)", better: "higher" },
  { name: "taskPrecision", label: "Task precision", better: "higher" },
  { name: "hallucinationRate", label: "Hallucination rate", better: "lower" },
  { name: "trapHitRate", label: "must-NOT-appear hit rate", better: "lower" },
  { name: "examRecall", label: "Exam-question recall", better: "higher" },
  { name: "dateAccuracy", label: "Date accuracy", better: "higher" },
  { name: "werMicro", label: "WER (AMI, pooled)", better: "lower" },
  { name: "der2", label: "DER me/others (AMI)", better: "lower" },
  { name: "meRecall", label: "My lines labelled as me", better: "higher" },
];

/** Report names are dates, numbered within a day: 2026-11-14, 2026-11-14-2. */
const sortKey = (file) => {
  const match = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/.exec(file);
  return match ? [match[1], Number(match[2] ?? 1)] : null;
};

/** The newest report file name in `dir`, or null. Ordered by name, not mtime (a checkout resets mtimes). */
export const findLatestReport = (dir = REPORTS_DIR) => {
  if (!fs.existsSync(dir)) return null;
  const dated = fs
    .readdirSync(dir)
    .map((file) => ({ file, key: sortKey(file) }))
    .filter((entry) => entry.key)
    .sort((a, b) => (a.key[0] === b.key[0] ? a.key[1] - b.key[1] : a.key[0] < b.key[0] ? -1 : 1));
  return dated.at(-1)?.file ?? null;
};

const pct = (value) => (typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "not measured");

/** The Markdown inside the markers, for a parsed report (or null: none yet). */
export const renderAccuracy = (report, file) => {
  if (!report) {
    return [
      "<!-- source: none -->",
      "**Not yet measured.** There is no evaluation report in `eval/reports/` yet: the baseline run",
      "needs a fresh daily Gemini quota (see [eval/README.md](eval/README.md)). This table is generated",
      "from the latest report by `npm run readme:accuracy` and is never typed by hand, so it stays empty",
      "until a real run exists.",
    ].join("\n");
  }

  const name = file.replace(/\.json$/, "");
  const headline = report.metrics?.headline ?? {};
  const cases = report.metrics?.cases ?? {};
  const day = typeof report.finishedAt === "string" ? report.finishedAt.slice(0, 10) : "unknown date";
  const models = report.models ? `${report.models.main} (summary), ${report.models.clean} (CLEAN, judge)` : "unknown models";

  return [
    `<!-- source: eval/reports/${file} -->`,
    `From [\`eval/reports/${name}.md\`](eval/reports/${name}.md), run on ${day} with ${models}.`,
    `Cases: ${cases.ok ?? 0} OK of ${cases.total ?? 0}; outages and budget stops are left out of every number.`,
    "",
    "| Metric | Value | Better |",
    "| --- | --- | --- |",
    ...HEADLINE.map((spec) => `| ${spec.label} | ${pct(headline[spec.name])} | ${spec.better} |`),
  ].join("\n");
};

/** The block currently in the README, and the report it names. */
export const readBlock = (readme) => {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error(`README.md has no ${START} ... ${END} block`);
  // A Windows checkout may have CRLF line ends; compare content only.
  const body = readme.slice(start + START.length, end).replace(/\r\n/g, "\n").trim();
  const source = /<!-- source: (.+?) -->/.exec(body)?.[1] ?? null;
  return { body, source };
};

export const replaceBlock = (readme, body) => {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error(`README.md has no ${START} ... ${END} block`);
  return `${readme.slice(0, start + START.length)}\n${body}\n${readme.slice(end)}`;
};

const loadReport = (file, dir) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));

/** What the block must be for the source it names. */
export const expectedFor = (source, dir = REPORTS_DIR) => {
  if (!source || source === "none") return renderAccuracy(null);
  const file = source.replace(/^eval\/reports\//, "");
  if (!fs.existsSync(path.join(dir, file))) throw new Error(`README names ${source}, which does not exist`);
  return renderAccuracy(loadReport(file, dir), file);
};

const main = () => {
  const readme = fs.readFileSync(README, "utf8");

  if (process.argv.includes("--check")) {
    const { body, source } = readBlock(readme);
    if (body !== expectedFor(source)) {
      console.error("README accuracy block was edited by hand or is stale: run `npm run readme:accuracy`.");
      process.exit(1);
    }
    const latest = findLatestReport();
    const named = source && source !== "none" ? source.replace(/^eval\/reports\//, "") : null;
    if (latest && latest !== named) console.log(`Note: a newer report exists (${latest}); run \`npm run readme:accuracy\`.`);
    console.log("README accuracy block matches its source.");
    return;
  }

  const latest = findLatestReport();
  const body = latest ? renderAccuracy(loadReport(latest, REPORTS_DIR), latest) : renderAccuracy(null);
  fs.writeFileSync(README, replaceBlock(readme, body));
  console.log(latest ? `README accuracy table from eval/reports/${latest}.` : "No eval report yet: README says \"Not yet measured\".");
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
