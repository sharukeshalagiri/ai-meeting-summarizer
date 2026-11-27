import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TITLE_LENGTH, titleProblems } from "./commit-title.mjs";

describe("titleProblems", () => {
  it("passes plain conventional titles", () => {
    for (const title of [
      "fix(live): check the audio cap after device auth",
      "refactor: finish renaming track-named identifiers",
      "feat!: drop the legacy chunk form",
      "docs(deploy): explain the demo seed",
    ]) {
      assert.deepEqual(titleProblems(title), [], title);
    }
  });

  it("needs a type and a colon", () => {
    assert.equal(titleProblems("Refactor: name code by domain").length, 1);
    assert.equal(titleProblems("update stuff").length, 1);
    assert.equal(titleProblems("fix:missing space").length, 1);
  });

  it("limits the length", () => {
    const title = `fix: ${"a".repeat(MAX_TITLE_LENGTH)}`;
    assert.match(titleProblems(title).join(" "), /characters or fewer/);
  });

  it("rejects track ids, process names and WIP", () => {
    assert.match(titleProblems("feat(w2-spk): voice diarization").join(" "), /track ids/);
    assert.match(titleProblems("w5-demo: demo mode").join(" "), /track ids/);
    assert.match(titleProblems("docs: Pair 3 wrap-up").join(" "), /process names/);
    assert.match(titleProblems("chore: wave 4 follow-ups").join(" "), /process names/);
    assert.match(titleProblems("feat: wip job queue").join(" "), /WIP/);
  });

  it("rejects an empty title and a trailing period", () => {
    assert.deepEqual(titleProblems("  "), ["The title is empty."]);
    assert.match(titleProblems("fix: a thing.").join(" "), /trailing period/);
  });
});
