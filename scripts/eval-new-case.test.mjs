import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCase } from "./eval-new-case.mjs";

test("creates a gitignored own-recording case with an empty answer key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-own-"));
  const caseDir = createCase({ slug: "weekly-sync", meeting: "m-1", mode: "project", now: new Date("2026-11-09T15:00:00Z") }, dir);

  const entry = JSON.parse(fs.readFileSync(path.join(caseDir, "case.json"), "utf8"));
  assert.equal(entry.id, "own-weekly-sync");
  assert.equal(entry.meetingId, "m-1");
  assert.equal(entry.meetingStart, "2026-11-09T15:00:00.000Z");

  const key = JSON.parse(fs.readFileSync(path.join(caseDir, "expected.json"), "utf8"));
  assert.deepEqual(key, { transcript: "(audio)", mode: "project", mustAppear: [], mustNotAppear: [] });

  assert.throws(() => createCase({ slug: "weekly-sync" }, dir), /already exists/);
  assert.throws(() => createCase({ slug: "Bad Slug" }, dir), /slug/);
  fs.rmSync(dir, { recursive: true });
});

test("the own-case folder is gitignored", () => {
  const gitignore = fs.readFileSync(path.join(import.meta.dirname, "..", ".gitignore"), "utf8");
  for (const line of ["eval/cases/own/", "eval/data/", "eval/runs/"]) assert.ok(gitignore.includes(line), line);
});
