/**
 * Rules for a PR title. PRs are squash-merged, so the title becomes the
 * commit subject on main, and the history should read as product changes,
 * not as notes from the process that built them: no track ids (w1-sum),
 * no "Pair 3" / "wave 4", no WIP, short enough for `git log --oneline`.
 */

export const MAX_TITLE_LENGTH = 72;

const TYPES = ["feat", "fix", "refactor", "perf", "test", "docs", "build", "ci", "chore", "revert"];

const CONVENTIONAL = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S`);

/** Returns the problems with a title; an empty list means it passes. */
export const titleProblems = (raw) => {
  const title = String(raw ?? "").trim();
  const problems = [];

  if (!title) return ["The title is empty."];

  if (!CONVENTIONAL.test(title)) {
    problems.push(`Start with a type and a colon, e.g. "fix(live): ..." (types: ${TYPES.join(", ")}).`);
  }
  if (title.length > MAX_TITLE_LENGTH) {
    problems.push(`Keep it to ${MAX_TITLE_LENGTH} characters or fewer (it is ${title.length}).`);
  }
  if (/\bw\d-[a-z]+/i.test(title)) {
    problems.push("Leave track ids (w1-sum, w4-acct) out; name what changed. Tracks go in branch names and labels.");
  }
  if (/\b(pair|wave)\s*\d/i.test(title)) {
    problems.push('Leave process names ("Pair 3", "wave 4") out; name what changed.');
  }
  if (/\bwip\b/i.test(title)) {
    problems.push("A WIP title would land on main as is; finish the change or mark the PR as a draft.");
  }
  if (/\.$/.test(title)) {
    problems.push("Drop the trailing period.");
  }

  return problems;
};
