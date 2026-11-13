#!/usr/bin/env node
/**
 * Fails when the current branch changes files outside its track's
 * ownership (docs/OWNERSHIP.md), or touches the Prisma schema/migrations
 * outside a schema/ branch.
 *
 *   npm run check:ownership                 # current branch vs origin/main
 *   node scripts/check-ownership.mjs --base origin/main --branch worktree-w1-ext
 *
 * Compares the merge-base with origin/main against the working tree,
 * plus untracked files, so it works both before and after committing.
 * In CI (GITHUB_HEAD_REF set) it compares committed changes only.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPaths, loadOwnership } from "./lib/ownership.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    // Keep git's line-ending warnings out of the report.
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const base = arg("base") ?? "origin/main";
const branch =
  arg("branch") ??
  process.env.GITHUB_HEAD_REF ??
  git("rev-parse", "--abbrev-ref", "HEAD");
const inCi = Boolean(process.env.GITHUB_HEAD_REF);

let mergeBase;
try {
  mergeBase = git("merge-base", base, "HEAD");
} catch {
  console.error(
    `Cannot find a merge-base with ${base}. Run \`git fetch origin\` first.`
  );
  process.exit(2);
}

const lines = (text) => text.split(/\r?\n/).filter(Boolean);

const changed = new Set(
  lines(
    inCi
      ? git("diff", "--name-only", "--no-renames", `${mergeBase}...HEAD`)
      : git("diff", "--name-only", "--no-renames", mergeBase)
  )
);

if (!inCi) {
  for (const file of lines(git("ls-files", "--others", "--exclude-standard"))) {
    changed.add(file);
  }
}

const ownership = loadOwnership(path.join(root, "docs/OWNERSHIP.md"));
const result = checkPaths({ branch, paths: [...changed], ownership });

if (result.mode === "skipped") {
  console.log(
    `check:ownership: "${branch}" is not a track or schema/ branch; ` +
      "ownership is not enforced."
  );
  process.exit(0);
}

const label = result.mode === "schema" ? "schema branch" : `track ${result.track}`;

if (result.violations.length === 0) {
  console.log(
    `check:ownership: OK (${label}, ${changed.size} changed file(s)).`
  );
  process.exit(0);
}

console.error(`check:ownership: ${result.violations.length} violation(s) on ${label}:`);
for (const v of result.violations) {
  console.error(`  ${v.path}  (${v.reason})`);
}
console.error(
  "\nRevert these, or list them under \"Requests for other tracks\" in your " +
    "PR. See docs/OWNERSHIP.md and docs/PARALLEL.md."
);
process.exit(1);
