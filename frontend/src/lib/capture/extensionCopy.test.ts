import { describe, expect, it } from "vitest";
import { checkExtensionCopy } from "./extensionCopy.check.mjs";

/**
 * The extension loads a committed, transpiled copy of this folder
 * (extension/lib/capture). If this fails, run:
 *   node extension/scripts/build-capture.mjs
 *
 * The script compares file text with CRLF normalized to LF, so the check
 * passes on a Windows (autocrlf) checkout as it does in CI.
 */
describe("extension/lib/capture", () => {
  it("is up to date with frontend/src/lib/capture", () => {
    const { status, stderr } = checkExtensionCopy();

    expect(stderr).toBe("");
    expect(status).toBe(0);
  });
});
