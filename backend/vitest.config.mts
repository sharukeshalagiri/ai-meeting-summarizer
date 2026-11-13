import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const tmp = path.join(os.tmpdir(), "ams-vitest");

export default defineConfig({
  test: {
    // test/ for cross-cutting suites; src/**/*.test.ts for tests that sit
    // next to the code they cover (parallel tracks add those).
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // lib/env.ts validates configuration at import time. Unit tests never
    // touch the database or Gemini, so placeholders are enough to let
    // modules load. Real values from a developer's .env are overridden so
    // tests behave the same on every machine and in CI.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DATABASE_URL: "postgresql://test:test@localhost:5433/unused",
      GEMINI_API_KEY: "test-key-not-real",
      // Uploads from route tests land in a temp dir, never the repo.
      UPLOAD_DIR: path.join(tmp, "meetings"),
      LIVE_CHUNK_DIR: path.join(tmp, "live"),
      DEVICE_TOKEN: "",
    },
  },
});
