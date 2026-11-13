#!/usr/bin/env node
/**
 * Prepares a git worktree for one parallel track.
 *
 *   npm run worktree:env <track>          e.g. npm run worktree:env w1-sum
 *   node scripts/worktree-env.mjs <track> --skip-install --skip-db
 *
 * 1. Ports from the track's slot in docs/OWNERSHIP.md:
 *    backend 5100+10*slot, frontend +1, ai-service +2.
 * 2. Writes backend/.env, frontend/.env and ai-service/.env, starting from
 *    the MAIN checkout's env files (falling back to .env.example), with this
 *    track's ports and database ai_meeting_summarizer_<track>.
 * 3. Tracks that own ai-service files (w1-asr, w2-spk) get their own
 *    ai-service and the full `npm run setup`. Everyone else points
 *    AI_SERVICE_URL at the main checkout's ai-service on :8000 and runs
 *    `npm run setup:light` (Node only, no torch).
 * 4. Starts the shared Postgres container and runs migrations, which
 *    creates the track's database.
 *
 * Refuses to run in the main checkout, which keeps the default ports.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  databaseNameFor,
  loadOwnership,
  ownsAiService,
  portsForSlot,
} from "./lib/ownership.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const trackName = args.find((a) => !a.startsWith("--"));
const flag = (name) => args.includes(`--${name}`);

const fail = (message) => {
  console.error(`worktree:env: ${message}`);
  process.exit(1);
};

const { tracks } = loadOwnership(path.join(here, "docs/OWNERSHIP.md"));

if (!trackName) {
  fail(`usage: npm run worktree:env <track>   (tracks: ${[...tracks.keys()].join(", ")})`);
}

const track = tracks.get(trackName);
if (!track) fail(`unknown track "${trackName}". Known: ${[...tracks.keys()].join(", ")}`);

const git = (...a) =>
  execFileSync("git", a, { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const top = path.resolve(git("rev-parse", "--show-toplevel"));
// The first entry of `git worktree list` is always the main checkout.
const mainCheckout = path.resolve(
  git("worktree", "list", "--porcelain").split(/\r?\n/)[0].replace(/^worktree /, "")
);

if (top === mainCheckout && !flag("allow-main")) {
  fail(
    "this is the main checkout. Run it inside a track worktree " +
      "(claude --worktree <track>). The main checkout keeps ports 5000/5173/8000."
  );
}

const ports = portsForSlot(track.slot);
const ownAi = ownsAiService(track);
const dbName = databaseNameFor(trackName);

/** Minimal .env reader/writer that keeps comments and order. */
const readEnv = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

const parseValue = (text, key) => {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m").exec(text ?? "");
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};

const setKeys = (text, values) => {
  let out = text.endsWith("\n") || !text ? text : `${text}\n`;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    // Replace an active or commented-out assignment, else append.
    const re = new RegExp(`^\\s*#?\\s*${key}\\s*=.*$`, "m");
    out = re.test(out) ? out.replace(re, line) : `${out}${line}\n`;
  }
  return out;
};

/** Main checkout's env file, else the example, with a note on which. */
const sourceEnv = (dir, names) => {
  for (const name of names) {
    const file = path.join(mainCheckout, dir, name);
    const text = readEnv(file);
    if (text !== null) return { text, from: path.relative(mainCheckout, file) };
  }
  const example = readEnv(path.join(here, dir, ".env.example")) ?? "";
  return { text: example, from: `${dir}/.env.example (no env file in main checkout)` };
};

const header = (from) =>
  `# Written by \`npm run worktree:env ${trackName}\` from ${from}.\n` +
  "# Re-run that command instead of editing ports or DATABASE_URL here.\n";

const stripHeader = (text) => text.replace(/^# Written by `npm run worktree:env[^\n]*\n# Re-run[^\n]*\n/, "");

// ---- backend/.env
const backendSrc = sourceEnv("backend", [".env"]);
const mainDbUrl =
  parseValue(backendSrc.text, "DATABASE_URL") ??
  "postgresql://postgres:postgres@localhost:5433/ai_meeting_summarizer";
const dbUrl = new URL(mainDbUrl);
dbUrl.pathname = `/${dbName}`;

const mainAiUrl = parseValue(backendSrc.text, "AI_SERVICE_URL") || "http://localhost:8000";

const backendEnv = setKeys(stripHeader(backendSrc.text), {
  PORT: ports.backend,
  DATABASE_URL: `"${dbUrl.toString()}"`,
  AI_SERVICE_URL: ownAi ? `http://localhost:${ports.aiService}` : mainAiUrl,
});

// ---- frontend/.env
const frontendSrc = sourceEnv("frontend", [".env", ".env.local"]);
const frontendEnv = setKeys(stripHeader(frontendSrc.text), {
  VITE_API_URL: `http://localhost:${ports.backend}/api`,
  FRONTEND_PORT: ports.frontend,
});

// ---- ai-service/.env
const aiSrc = sourceEnv("ai-service", [".env"]);
let aiEnv = setKeys(stripHeader(aiSrc.text), { AI_SERVICE_PORT: ports.aiService });
if (!ownAi) {
  aiEnv =
    "# This track uses the SHARED ai-service in the main checkout (:8000);\n" +
    "# backend/.env AI_SERVICE_URL points there. This file is unused.\n" +
    aiEnv;
}

const write = (rel, from, body) => {
  fs.writeFileSync(path.join(here, rel), header(from) + body);
  console.log(`  wrote ${rel}  (from ${from})`);
};

console.log(`worktree:env ${trackName} (slot ${track.slot})`);
write("backend/.env", backendSrc.from, backendEnv);
write("frontend/.env", frontendSrc.from, frontendEnv);
write("ai-service/.env", aiSrc.from, aiEnv);

if (!parseValue(backendEnv, "GEMINI_API_KEY")) {
  console.warn(
    "  ! GEMINI_API_KEY is empty: add it to the main checkout's backend/.env " +
      "and re-run (the backend will not boot without it)."
  );
}

const run = (cmd, cmdArgs) => {
  console.log(`\n> ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: here, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) fail(`"${cmd} ${cmdArgs.join(" ")}" failed (exit ${r.status}).`);
};

if (!flag("skip-install")) {
  run("npm", ["run", ownAi ? "setup" : "setup:light"]);
}

if (!flag("skip-db")) {
  run("npm", ["run", "db:up"]);
  run("npm", ["run", "db:migrate"]);
}

console.log(`
Ready: ${trackName}
  backend     http://localhost:${ports.backend}      (npm run dev:api)
  frontend    http://localhost:${ports.frontend}      (npm run dev:web)
  ai-service  ${ownAi ? `http://localhost:${ports.aiService}      (npm run dev:ai)` : `shared ${mainAiUrl} (run \`npm run dev:ai\` in the main checkout)`}
  database    ${dbName}
`);
