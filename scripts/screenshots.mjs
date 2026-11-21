#!/usr/bin/env node
/**
 * README screenshots of the demo (w5-demo): `npm run screenshots`.
 *
 * Runs e2e/screenshots (Playwright, one headless chromium, the API
 * mocked in the browser from the demo seed's builder) and writes
 * docs/images/*.png. Needs `npm run setup:e2e` once. No backend,
 * database or Docker is started.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2e = path.join(root, "e2e");
const images = path.join(root, "docs", "images");

if (!fs.existsSync(path.join(e2e, "node_modules", "@playwright", "test"))) {
  console.error("Playwright is not installed: run `npm run setup:e2e` first.");
  process.exit(1);
}

fs.mkdirSync(images, { recursive: true });

const result = spawnSync("npx", ["playwright", "test", "-c", "screenshots/playwright.config.ts"], {
  cwd: e2e,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.status !== 0) process.exit(result.status ?? 1);

for (const file of fs.readdirSync(images).filter((f) => f.endsWith(".png")).sort()) {
  const kb = fs.statSync(path.join(images, file)).size / 1024;
  console.log(`docs/images/${file}  ${kb.toFixed(0)} KB`);
}
