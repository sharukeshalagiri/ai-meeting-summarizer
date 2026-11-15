import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Runs the real CLI (`tsx src/cli.ts run`) in a child process, the way
 * `npm run eval` does: ESM harness, CommonJS pipeline, real
 * @google/genai SDK. Only the network is faked, by a preloaded fetch.
 *
 * This is the setup that blinded the first meter (it wrapped a client
 * the pipeline never used). The test compares what the fake endpoint
 * actually answered with what the meter counted.
 */

const EVAL_DIR = path.resolve(__dirname, "..");
const PRELOAD = pathToFileURL(path.join(__dirname, "support/fake-gemini-preload.mjs")).href;

const runCli = (mode: "ok" | "503") => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cli-"));
  const countFile = path.join(out, "requests.txt");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", PRELOAD, "src/cli.ts", "run", "--cases", "project-meeting", "--out", out, "--rpm", "0", "--retry-wait", "0", "--no-judge", "--title", "cli"],
    {
      cwd: EVAL_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        EVAL_NO_ENV_FILE: "1",
        GEMINI_API_KEY: "fake-key-for-cli-test",
        DATABASE_URL: "postgresql://unused:unused@localhost:1/unused",
        LOG_LEVEL: "error",
        FAKE_GEMINI_MODE: mode,
        FAKE_GEMINI_COUNT_FILE: countFile,
      },
    }
  );
  const report = fs.existsSync(path.join(out, "reports/cli.json"))
    ? JSON.parse(fs.readFileSync(path.join(out, "reports/cli.json"), "utf8"))
    : null;
  const sent = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : -1;
  fs.rmSync(out, { recursive: true, force: true });
  return { result, report, sent };
};

describe("eval CLI end to end (fake Gemini endpoint)", () => {
  it("meters every request the pipeline actually sends", () => {
    const { result, report, sent } = runCli("ok");
    expect(result.status, result.stderr).toBe(0);
    expect(sent).toBe(3); // CLEAN, EXTRACT, VERIFY
    expect(report.used).toBe(sent);
    expect(report.cases[0]).toMatchObject({ id: "project-meeting", status: "OK" });
    expect(report.cases[0].calls.calls).toBe(3);
  }, 60_000);

  it("reports an overloaded model as INFRA_ERROR with its 503s counted", () => {
    const { result, report, sent } = runCli("503");
    expect(result.status, result.stderr).toBe(0);
    expect(report.used).toBe(sent);
    expect(report.cases[0].status).toBe("INFRA_ERROR");
    expect(report.cases[0].calls.http503).toBeGreaterThanOrEqual(3);
    expect(report.metrics.cases).toMatchObject({ infra: 1, ok: 0 });
  }, 60_000);
});
