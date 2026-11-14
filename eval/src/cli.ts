/**
 * npm run eval [-- --cases a,b|smoke|synthetic|ami] [--cap 30] [--no-judge] [--diarize] [--retry-wait 60]
 * npm run eval:check  [-- --report eval/reports/<file>.json]
 * npm run eval:accept -- --note "why" [--report ...]
 * npm run eval:import-corrections [-- --case own-<slug>] [--write]
 *
 * Backend modules are imported only after backend/.env is loaded,
 * because lib/env.ts validates configuration at import time.
 */
import fs from "node:fs";
import path from "node:path";
import { acceptBaseline, checkOutcome, compare, type Baseline } from "./baseline";
import { EVAL_DIR, OWN_DIR, ROOT, listCases, loadCase, selectCases } from "./cases";
import type { Pricing } from "./meter";
import { aggregate, renderMarkdown, type Metrics } from "./report";
import type { CaseResult, RunResult } from "./run";
import { scoreSummary } from "./score";
import type { AnswerKey, LoadedCase } from "./types";

const REPORTS = path.join(EVAL_DIR, "reports");
const RUNS = path.join(EVAL_DIR, "runs");
const BASELINE = path.join(EVAL_DIR, "baseline.json");

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

/** Paths from the command line are relative to where npm was run, not eval/. */
const userPath = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

/** backend/.env, if present; its values are never printed. Shell values win. */
const loadBackendEnv = () => {
  const file = path.join(ROOT, "backend/.env");
  if (fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Unreadable env file: fall back to the shell environment.
    }
  }
  process.env.LOG_LEVEL ??= "warn";
};

const reportName = (stamp = new Date()) => {
  const day = stamp.toISOString().slice(0, 10);
  let name = day;
  for (let n = 2; fs.existsSync(path.join(REPORTS, `${name}.json`)); n++) name = `${day}-${n}`;
  return name;
};

const latestReport = (): string => {
  const files = fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).filter((f) => f.endsWith(".json")).sort() : [];
  if (!files.length) throw new Error("No report in eval/reports yet; run `npm run eval` first.");
  // Same-day reports are numbered (2026-11-14, 2026-11-14-2): sort by mtime to be safe.
  return files
    .map((f) => path.join(REPORTS, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .at(-1)!;
};

const loadBaseline = (): Baseline =>
  fs.existsSync(BASELINE) ? readJson<Baseline>(BASELINE) : { status: "placeholder", metrics: {}, tolerances: {} };

/** What a committed report may contain: no summary text, nothing from own recordings. */
const publicCase = (c: CaseResult) => {
  const { summary: _summary, produced: _produced, tldr: _tldr, ...rest } = c;
  if (c.type !== "own" || !rest.score) return rest;
  return {
    ...rest,
    score: { ...rest.score, mustAppear: { ...rest.score.mustAppear, items: [] }, traps: { ...rest.score.traps, hit: rest.score.traps.hit.map(() => "(own)") } },
  };
};

const writeReport = (run: RunResult, metrics: Metrics, title: string) => {
  const baseline = loadBaseline();
  const comparisons = compare(metrics, baseline);
  const name = title;
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, `${name}.md`), renderMarkdown(run, metrics, comparisons, name));
  writeJson(path.join(REPORTS, `${name}.json`), {
    report: name,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    models: run.models,
    cap: run.cap,
    used: run.used,
    judge: { status: run.judge.status, reason: run.judge.reason, calls: run.judge.calls },
    metrics,
    comparisons,
    cases: run.cases.map(publicCase),
  });
  return { name, comparisons };
};

async function runCommand() {
  loadBackendEnv();
  const replay = value("replay");

  const entries = selectCases(listCases(), value("cases"));
  const loaded: LoadedCase[] = [];
  const missing: CaseResult[] = [];
  for (const entry of entries) {
    const result = loadCase(entry);
    if ("missing" in result) {
      console.log(`skip ${entry.id}: ${result.missing}`);
      missing.push({ id: entry.id, type: entry.type, status: "SKIPPED", reason: result.missing, durationMs: 0, wallMs: 0, estimate: 0, attempts: 0, calls: emptyCalls() });
    } else loaded.push(result);
  }

  let run: RunResult;
  if (replay) {
    // Re-score a stored run with today's scoring code: zero Gemini calls.
    run = readJson<RunResult>(userPath(replay));
    for (const result of run.cases) {
      const c = loaded.find((l) => l.entry.id === result.id);
      if (!c?.key || !c.segments || (result.status !== "OK" && result.status !== "PIPELINE_ERROR")) continue;
      result.score = scoreSummary({
        key: c.key,
        segments: c.segments,
        produced: result.produced ?? [],
        tldr: result.tldr ?? "",
        verdict: run.judge.verdicts?.[result.id],
      });
    }
  } else {
    const hasTranscript = loaded.some((c) => c.segments);
    if (hasTranscript && !process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set (backend/.env or the shell); transcript cases need it.");
    }
    if (loaded.some((c) => c.audioPath) && (process.env.TRANSCRIPTION_PROVIDER ?? "local") !== "local" && !flag("allow-paid-asr")) {
      throw new Error("TRANSCRIPTION_PROVIDER is not local; audio cases would bill a paid provider. Pass --allow-paid-asr to accept.");
    }

    const { runEval } = await import("./run");
    run = await runEval({
      cases: loaded,
      cap: Number(value("cap") ?? 30),
      judge: !flag("no-judge"),
      diarize: flag("diarize"),
      retryWaitMs: Number(value("retry-wait") ?? 60) * 1000,
      log: (line) => console.log(line),
    });
    run.cases.push(...missing);

    const stamp = run.startedAt.replace(/[:.]/g, "-");
    writeJson(path.join(RUNS, `${stamp}.json`), run);
    console.log(`raw run (gitignored, for --replay): ${path.relative(ROOT, path.join(RUNS, `${stamp}.json`))}`);
  }

  const pricing = readJson<Pricing>(path.join(EVAL_DIR, "pricing.json"));
  const metrics = aggregate(run, pricing);
  const { name } = writeReport(run, metrics, value("title") ?? reportName());
  console.log(`report: eval/reports/${name}.md`);
  console.log(
    `Gemini requests ${metrics.gemini.used}/${metrics.gemini.cap}; cases OK ${metrics.cases.ok}, INFRA_ERROR ${metrics.cases.infra}, BUDGET_STOP ${metrics.cases.budget}, PIPELINE_ERROR ${metrics.cases.pipeline}, skipped ${metrics.cases.skipped}`
  );
}

function emptyCalls() {
  return { calls: 0, retries: 0, http503: 0, http429: 0, network: 0, gaveUp: 0, refused: 0, ms: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
}

function checkCommand(): number {
  const file = value("report") ? userPath(value("report")!) : latestReport();
  const report = readJson<{ metrics: Metrics }>(file);
  const comparisons = compare(report.metrics, loadBaseline());
  for (const c of comparisons) {
    console.log(`${c.verdict.padEnd(12)} ${c.name}: ${c.current === null ? "n/a" : c.current.toFixed(3)} (baseline ${c.baseline === null ? "n/a" : c.baseline.toFixed(3)}, tolerance ${c.tolerance})`);
  }
  const outcome = checkOutcome(report.metrics, comparisons);
  console.log(`${path.relative(ROOT, file)}: ${outcome.summary}`);
  return outcome.exit;
}

function acceptCommand(): number {
  const note = value("note");
  if (!note) throw new Error('eval:accept needs --note "why the baseline changes".');
  const file = value("report") ? userPath(value("report")!) : latestReport();
  const report = readJson<{ report: string; metrics: Metrics }>(file);
  const outcome = checkOutcome(report.metrics, []);
  if (outcome.exit !== 0) throw new Error(`Refusing to accept an inconclusive run. ${outcome.summary}`);
  const next = acceptBaseline(report.metrics, loadBaseline(), report.report, note);
  writeJson(BASELINE, next);
  console.log(`baseline updated from ${path.relative(ROOT, file)}`);
  return 0;
}

async function importCorrectionsCommand(): Promise<number> {
  loadBackendEnv();
  const { findByMeetingId } = await import("../../backend/src/repositories/correction.repository");
  const { proposeFromCorrections, applyProposals, describeProposal } = await import("./corrections");

  const wanted = value("case");
  const cases = listCases().filter((c) => c.type === "own" && c.meetingId && (!wanted || c.id === wanted));
  if (!cases.length) {
    console.log("No own-recording case with a meetingId (eval/cases/own/<slug>/case.json). Create one with npm run eval:new-case.");
    return 0;
  }

  let pending = 0;
  for (const entry of cases) {
    const keyFile = path.join(OWN_DIR, entry.id.replace(/^own-/, ""), "expected.json");
    const key: AnswerKey = fs.existsSync(keyFile)
      ? readJson<AnswerKey>(keyFile)
      : { transcript: "(audio)", mode: "general", mustAppear: [], mustNotAppear: [] };
    const rows = await findByMeetingId(entry.meetingId!);
    const proposals = proposeFromCorrections(key, rows);
    const changes = proposals.filter((p) => p.type !== "ignored");
    console.log(`\n${entry.id} (meeting ${entry.meetingId}): ${rows.length} correction(s), ${changes.length} proposed change(s)`);
    proposals.forEach((p) => console.log(`  ${describeProposal(p)}`));

    if (changes.length && flag("write")) {
      writeJson(keyFile, applyProposals(key, proposals));
      console.log(`  written: ${path.relative(ROOT, keyFile)}`);
    } else {
      pending += changes.length;
    }
  }

  if (pending && !flag("write")) console.log("\nNothing written. Re-run with --write to apply the proposals above.");
  const { prisma } = await import("../../backend/src/lib/prisma");
  await prisma.$disconnect();
  return 0;
}

const main = async (): Promise<number> => {
  switch (command) {
    case "run":
      await runCommand();
      return 0;
    case "check":
      return checkCommand();
    case "accept":
      return acceptCommand();
    case "import-corrections":
      return importCorrectionsCommand();
    default:
      console.error("usage: tsx src/cli.ts run|check|accept|import-corrections [options]");
      return 64;
  }
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
