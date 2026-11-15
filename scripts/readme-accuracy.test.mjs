import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  END,
  expectedFor,
  findLatestReport,
  HEADLINE,
  README,
  readBlock,
  renderAccuracy,
  replaceBlock,
  START,
} from "./readme-accuracy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const report = (headline) => ({
  report: "2026-11-20",
  finishedAt: "2026-11-20T10:00:00.000Z",
  models: { main: "gemini-flash-latest", clean: "gemini-flash-lite-latest" },
  metrics: { cases: { total: 8, ok: 7 }, headline },
});

describe("README accuracy table", () => {
  it("says 'not yet measured' and shows no number without a report", () => {
    const text = renderAccuracy(null);
    assert.match(text, /Not yet measured/);
    assert.doesNotMatch(text, /\d+(\.\d+)?%/);
  });

  it("renders every headline metric from a report, and never fills a gap", () => {
    const text = renderAccuracy(report({ taskRecallFull: 0.8, hallucinationRate: 0.05, werMicro: null }), "2026-11-20.json");
    assert.match(text, /\| Task recall \(text \+ owner \+ date\) \| 80\.0% \| higher \|/);
    assert.match(text, /\| Hallucination rate \| 5\.0% \| lower \|/);
    assert.match(text, /\| WER \(AMI, pooled\) \| not measured \|/);
    assert.match(text, /\| Date accuracy \| not measured \|/);
    assert.equal((text.match(/\d+\.\d%/g) ?? []).length, 2);
    assert.match(text, /eval\/reports\/2026-11-20\.md/);
  });

  it("picks the newest report by name, numbered runs included", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readme-acc-"));
    try {
      assert.equal(findLatestReport(dir), null);
      for (const f of ["2026-11-14.json", "2026-11-14-2.json", "2026-11-14-10.json", "2026-11-14.md", "notes.json"]) {
        fs.writeFileSync(path.join(dir, f), "{}");
      }
      assert.equal(findLatestReport(dir), "2026-11-14-10.json");
      fs.writeFileSync(path.join(dir, "2026-11-15.json"), "{}");
      assert.equal(findLatestReport(dir), "2026-11-15.json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces only the marked block", () => {
    const readme = `# x\n\n${START}\nold\n${END}\n\nafter\n`;
    const next = replaceBlock(readme, "new body");
    assert.equal(next, `# x\n\n${START}\nnew body\n${END}\n\nafter\n`);
    assert.equal(readBlock(next).body, "new body");
  });

  it("uses the same headline metrics and labels as eval/src/report.ts", () => {
    const source = fs.readFileSync(path.join(ROOT, "eval", "src", "report.ts"), "utf8");
    const specs = [...source.matchAll(/\{ name: "(\w+)", label: "([^"]+)", better: "(\w+)"/g)].map((m) => ({
      name: m[1],
      label: m[2],
      better: m[3],
    }));
    assert.deepEqual(specs, HEADLINE);
  });

  it("the committed README block is the generator's output for the report it names", () => {
    const { body, source } = readBlock(fs.readFileSync(README, "utf8"));
    assert.equal(body, expectedFor(source));
  });
});
