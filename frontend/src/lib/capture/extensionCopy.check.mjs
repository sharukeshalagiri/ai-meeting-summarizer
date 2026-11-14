import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../extension/scripts/build-capture.mjs"
);

/**
 * Test helper for extensionCopy.test.ts. Runs build-capture.mjs --check
 * in a Node child process rather than importing it into Vite: on a
 * Windows checkout (core.autocrlf=true) the script's shebang line ends in
 * CRLF, which Vite's module transform rejects while Node accepts it.
 * Plain .mjs (typed by the .d.mts next to it) because the app tsconfig
 * has no Node types.
 */
export const checkExtensionCopy = () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
};
