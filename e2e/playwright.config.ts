import { defineConfig } from "@playwright/test";

/**
 * One chromium, one worker: the suite is small and the dev machine has
 * little memory. The frontend dev server is started here with an API URL
 * nothing listens on; every /api request is answered by page.route mocks
 * in the tests (see tests/mockApi.ts), so no backend, database, Whisper
 * or Gemini is involved.
 */
const port = Number(process.env.E2E_PORT ?? 5161);

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm --prefix ../frontend run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    // Never attach to a dev server that talks to a real backend.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // Port 9 (discard): any request a test forgot to mock fails fast.
      VITE_API_URL: "http://127.0.0.1:9/api",
      VITE_DEVICE_TOKEN: "",
    },
  },
});
