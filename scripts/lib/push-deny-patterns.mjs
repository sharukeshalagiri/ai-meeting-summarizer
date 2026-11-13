/**
 * Every form of `git push` that could rewrite or delete `main`, or force
 * anything. .claude/settings.json denies each pattern for BOTH the Bash
 * and PowerShell tools; permissions.test.mjs checks that it does and
 * exercises the patterns against real push commands.
 *
 * Pattern syntax follows Claude Code permission rules: `*` matches any
 * run of characters (spaces included), and a trailing " *" also matches
 * the bare command. A chained command (&&, |, ;) is checked part by part.
 */
export const PUSH_DENY_PATTERNS = [
  // Bare push follows the upstream, which is main when on main.
  "git push",

  // Force in any form.
  "git push --force *",
  "git push -f *",
  "git push --force-with-lease *",
  "git push * --force",
  "git push * --force *",
  "git push * -f",
  "git push * -f *",
  "git push * --force-with-lease",
  "git push * --force-with-lease *",
  "git push * +*",

  // Push every branch (includes main).
  "git push --all *",
  "git push * --all",
  "git push * --all *",
  "git push --mirror *",
  "git push * --mirror",
  "git push * --mirror *",

  // main as the source/destination, short or full ref.
  "git push * main",
  "git push * main *",
  "git push * refs/heads/main",
  "git push * refs/heads/main *",
  "git push * *:main",
  "git push * *:main *",
  "git push * *:refs/heads/main",
  "git push * *:refs/heads/main *",

  // Deleting main.
  "git push --delete * main",
  "git push --delete * main *",
  "git push * --delete main",
  "git push * --delete main *",
  "git push -d * main",
  "git push -d * main *",
  "git push * -d main",
  "git push * -d main *",
];
