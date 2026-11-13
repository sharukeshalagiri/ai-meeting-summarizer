import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PUSH_DENY_PATTERNS } from "./push-deny-patterns.mjs";

/**
 * Checks the push deny rules in .claude/settings.json.
 *
 * `ruleMatches` emulates Claude Code's documented matching for Bash and
 * PowerShell rules: `*` matches any characters (spaces included), and a
 * trailing " *" also matches the bare command. It is a model of the
 * documented behaviour, not Claude Code's own matcher, so it guards
 * against gaps in OUR patterns.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const settings = JSON.parse(
  fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8")
);

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export function ruleMatches(pattern, command) {
  const cmd = command.trim().replace(/\s+/g, " ");
  const re = pattern.split("*").map(escape).join(".*");

  if (new RegExp(`^${re}$`).test(cmd)) return true;

  // "foo *" also matches bare "foo".
  return pattern.endsWith(" *") && cmd === pattern.slice(0, -2);
}

const denyFor = (tool) =>
  settings.permissions.deny
    .filter((rule) => rule.startsWith(`${tool}(`))
    .map((rule) => rule.slice(tool.length + 1, -1));

const isDenied = (tool, command) =>
  denyFor(tool).some((pattern) => ruleMatches(pattern, command));

const DENIED = [
  // to main, every spelling
  "git push",
  "git push origin main",
  "git push -u origin main",
  "git push origin main --no-verify",
  "git push origin HEAD:main",
  "git push origin abc123:main",
  "git push origin w1-sum/impl:main",
  "git push origin main:main",
  "git push origin HEAD:refs/heads/main",
  "git push origin abc123:refs/heads/main",
  "git push origin refs/heads/main",
  "git push origin HEAD:refs/heads/main --no-verify",
  // deleting main
  "git push origin :main",
  "git push origin :refs/heads/main",
  "git push --delete origin main",
  "git push origin --delete main",
  "git push -d origin main",
  "git push origin -d main",
  // everything at once
  "git push --all origin",
  "git push origin --all",
  "git push --mirror origin",
  // force, any branch
  "git push --force origin w1-sum/impl",
  "git push -f origin w1-sum/impl",
  "git push origin w1-sum/impl --force",
  "git push origin w1-sum/impl -f",
  "git push --force-with-lease origin w1-sum/impl",
  "git push origin w1-sum/impl --force-with-lease",
  "git push origin +w1-sum/impl",
  "git push origin +HEAD:w1-sum/impl",
];

const ALLOWED = [
  "git push -u origin w1-sum/impl",
  "git push origin w1-sum/impl",
  "git push -u origin worktree-w1-ext",
  "git push origin chore/parallel-foundation",
  "git push -u origin chore/main-menu-fix",
  "git push origin feature/remain",
  "git push origin domain",
  "git push origin w1-sum/impl:w1-sum/impl",
  "git push origin HEAD:w1-asr/impl",
  "git push --set-upstream origin w2-spk/impl",
];

describe("push deny rules", () => {
  for (const tool of ["Bash", "PowerShell"]) {
    it(`${tool}: settings.json contains every push deny pattern`, () => {
      const rules = new Set(denyFor(tool));
      for (const pattern of PUSH_DENY_PATTERNS) {
        assert.ok(rules.has(pattern), `${tool}(${pattern}) missing`);
      }
    });

    it(`${tool}: denies every dangerous push`, () => {
      for (const command of DENIED) {
        assert.ok(isDenied(tool, command), `${tool} should deny: ${command}`);
      }
    });

    it(`${tool}: still allows pushing a feature branch`, () => {
      for (const command of ALLOWED) {
        assert.ok(!isDenied(tool, command), `${tool} should allow: ${command}`);
      }
    });
  }

  it("feature-branch pushes still go through the ask rule", () => {
    const ask = settings.permissions.ask;
    assert.ok(ask.includes("Bash(git push *)"));
    assert.ok(ask.includes("PowerShell(git push *)"));
  });
});

describe("ruleMatches (emulated rule syntax)", () => {
  it("treats * as any characters and trailing ' *' as optional", () => {
    assert.ok(ruleMatches("git status *", "git status"));
    assert.ok(ruleMatches("git status *", "git status --short"));
    assert.ok(!ruleMatches("ls *", "lsof"));
    assert.ok(ruleMatches("git * main", "git push origin main"));
    assert.ok(!ruleMatches("git push", "git push origin x"));
  });
});
