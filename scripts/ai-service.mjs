#!/usr/bin/env node
/**
 * Runs a command inside the ai-service virtualenv, cross-platform.
 *
 *   node scripts/ai-service.mjs dev      # uvicorn on AI_SERVICE_PORT (default 8000)
 *   node scripts/ai-service.mjs test     # pytest
 *   node scripts/ai-service.mjs install  # create .venv, install requirements
 *
 * The venv lives at ai-service/.venv; its interpreter is under Scripts/
 * on Windows and bin/ elsewhere. Paths are resolved from this file, so it
 * works from any git worktree.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = path.join(root, "ai-service");
const venvDir = path.join(serviceDir, ".venv");
const isWindows = process.platform === "win32";
const venvPython = path.join(
  venvDir,
  isWindows ? "Scripts/python.exe" : "bin/python"
);

// Shell variables win over ai-service/.env, so a worktree can override
// the port inline.
const envFile = path.join(serviceDir, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, {
    cwd: serviceDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const requireVenv = () => {
  if (!fs.existsSync(venvPython)) {
    console.error(
      "ai-service/.venv not found. Run `npm run setup:ai` (or " +
        "`npm run setup:ai:test` for test-only dependencies)."
    );
    process.exit(1);
  }
};

const command = process.argv[2];

switch (command) {
  case "install":
  case "install:test": {
    if (!fs.existsSync(venvPython)) {
      run(isWindows ? "python" : "python3", ["-m", "venv", ".venv"]);
    }
    const files =
      command === "install"
        ? ["requirements.txt", "requirements-dev.txt"]
        : ["requirements-dev.txt"];
    run(venvPython, [
      "-m",
      "pip",
      "install",
      ...files.flatMap((file) => ["-r", file]),
    ]);
    break;
  }
  case "dev": {
    requireVenv();
    const port = process.env.AI_SERVICE_PORT || "8000";
    run(venvPython, [
      "-m",
      "uvicorn",
      "main:app",
      "--host",
      "127.0.0.1",
      "--port",
      port,
    ]);
    break;
  }
  case "test":
    requireVenv();
    run(venvPython, ["-m", "pytest", ...process.argv.slice(3)]);
    break;
  default:
    console.error(
      "Usage: node scripts/ai-service.mjs <install|install:test|dev|test>"
    );
    process.exit(1);
}
