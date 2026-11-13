import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
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
    },
  },
});
