#!/usr/bin/env node
/**
 * Copies frontend/src/lib/capture/*.ts into extension/lib/capture/*.js.
 *
 * The extension is loaded unpacked, with no bundler, and cannot import
 * files outside its folder. Keeping one TypeScript source (tested with
 * vitest) and committing a transpiled copy means the web page and the
 * extension record exactly the same way, and "Load unpacked" still
 * needs no build step. A vitest test (extensionCopy.test.ts) fails when
 * the committed copy is stale.
 *
 *   node extension/scripts/build-capture.mjs          write the copy
 *   node extension/scripts/build-capture.mjs --check  exit 1 if stale
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const SOURCE_DIR = join(repoRoot, "frontend", "src", "lib", "capture");
export const OUT_DIR = join(repoRoot, "extension", "lib", "capture");

/** typescript comes from the frontend's devDependencies. */
const loadTypescript = () =>
  createRequire(join(repoRoot, "frontend", "package.json"))("typescript");

/** Source files that ship: no tests, no declaration files. */
export const sourceFiles = () =>
  readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".ts") && !/\.(test|d)\.ts$/.test(name))
    .sort();

const normalize = (text) => text.replace(/\r\n/g, "\n");

/** Transpiles one file and rewrites `./x.ts` imports to `./x.js`. */
export const transpile = (ts, sourceText, fileName) => {
  const { outputText } = ts.transpileModule(sourceText, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      removeComments: false,
    },
  });

  const body = outputText.replace(
    /(\bfrom\s+["']\.\.?\/[^"']+)\.ts(["'])/g,
    "$1.js$2"
  );

  return (
    `// GENERATED from frontend/src/lib/capture/${fileName} by\n` +
    `// extension/scripts/build-capture.mjs. Do not edit; edit the source.\n` +
    normalize(body)
  );
};

/** Returns the output files that differ from what transpiling would produce. */
export const buildCapture = ({ check = false } = {}) => {
  const ts = loadTypescript();
  const stale = [];

  for (const name of sourceFiles()) {
    const source = readFileSync(join(SOURCE_DIR, name), "utf8");
    const expected = transpile(ts, normalize(source), name);
    const outPath = join(OUT_DIR, name.replace(/\.ts$/, ".js"));
    const current = existsSync(outPath)
      ? normalize(readFileSync(outPath, "utf8"))
      : null;

    if (current === expected) continue;

    stale.push(outPath);

    if (!check) writeFileSync(outPath, expected);
  }

  // Outputs whose source was removed.
  const wanted = new Set(sourceFiles().map((n) => n.replace(/\.ts$/, ".js")));
  for (const name of readdirSync(OUT_DIR)) {
    if (name.endsWith(".js") && !wanted.has(name)) stale.push(join(OUT_DIR, name));
  }

  return stale;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const check = process.argv.includes("--check");
  const stale = buildCapture({ check });

  if (check && stale.length) {
    console.error(
      "extension/lib/capture is stale. Run: node extension/scripts/build-capture.mjs\n" +
        stale.map((p) => `  ${p}`).join("\n")
    );
    process.exit(1);
  }

  console.log(
    check
      ? "extension/lib/capture is up to date."
      : `Wrote ${stale.length} file(s) to extension/lib/capture.`
  );
}
