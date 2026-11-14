#!/usr/bin/env node
/**
 * Runs the desktop recorder's tests in its own virtualenv, cross-platform.
 *
 *   node desktop-recorder/run-tests.mjs           # create .venv if needed, install, pytest
 *   node desktop-recorder/run-tests.mjs --no-install
 *
 * The venv lives at desktop-recorder/.venv (gitignored). Only
 * requirements-dev.txt is installed: numpy, soundfile, requests, psutil
 * and pytest, no audio-device or tray packages, so it runs on a CI box
 * with no sound card. Paths resolve from this file, so it works from any
 * worktree.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const venvPython = path.join(dir, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");
const args = process.argv.slice(2);
const noInstall = args.includes("--no-install");
const pytestArgs = args.filter((a) => a !== "--no-install");

const run = (cmd, cmdArgs) => {
  const result = spawnSync(cmd, cmdArgs, { cwd: dir, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!fs.existsSync(venvPython)) {
  // `py -3` is the reliable launcher on Windows; python3 elsewhere.
  const [cmd, pre] = isWindows ? ["py", ["-3"]] : ["python3", []];
  run(cmd, [...pre, "-m", "venv", ".venv"]);
}
if (!noInstall) {
  run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", "requirements-dev.txt"]);
}
run(venvPython, ["-m", "pytest", ...pytestArgs]);
