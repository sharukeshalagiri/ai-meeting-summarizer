import { describe, expect, it } from "vitest";
import { buildCapture } from "../../../../extension/scripts/build-capture.mjs";

/**
 * The extension loads a committed, transpiled copy of this folder
 * (extension/lib/capture). If this fails, run:
 *   node extension/scripts/build-capture.mjs
 */
describe("extension/lib/capture", () => {
  it("is up to date with frontend/src/lib/capture", () => {
    expect(buildCapture({ check: true })).toEqual([]);
  });
});
