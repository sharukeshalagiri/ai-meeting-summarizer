import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const tmp = path.join(os.tmpdir(), "ams-eval-vitest");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The harness imports backend modules, and lib/env.ts validates
    // configuration at import time. Placeholders let them load; no test
    // reaches Gemini, the ai-service or the database.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DATABASE_URL: "postgresql://test:test@localhost:5433/unused",
      GEMINI_API_KEY: "test-key-not-real",
      UPLOAD_DIR: path.join(tmp, "meetings"),
      LIVE_CHUNK_DIR: path.join(tmp, "live"),
      DEVICE_TOKEN: "",
      TRANSCRIPTION_PROVIDER: "local",
    },
  },
});
