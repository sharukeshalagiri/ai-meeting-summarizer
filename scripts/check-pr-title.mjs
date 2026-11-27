#!/usr/bin/env node
/**
 * Fails when a PR title would make a poor commit subject on main
 * (rules in lib/commit-title.mjs).
 *
 *   PR_TITLE="fix(live): ..." node scripts/check-pr-title.mjs
 *   node scripts/check-pr-title.mjs "fix(live): ..."
 *
 * CI passes the title through an environment variable, never inline in
 * the shell command, because a title is untrusted text.
 */
import { titleProblems } from "./lib/commit-title.mjs";

const title = process.argv[2] ?? process.env.PR_TITLE ?? "";
const problems = titleProblems(title);

if (problems.length) {
  console.error(`PR title: "${title}"`);
  for (const problem of problems) console.error(`- ${problem}`);
  console.error("PRs are squash-merged, so this title becomes the commit subject on main.");
  process.exit(1);
}
console.log(`PR title ok: "${title}"`);
