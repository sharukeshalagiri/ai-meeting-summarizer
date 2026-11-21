import { defineConfig } from "@playwright/test";
import { API_BASE } from "../tests/mockApi";

/**
 * README screenshots: `npm run screenshots` at the repo root.
 *
 * The seeded demo, rendered by the real frontend with the API answered
 * in the browser (demoApi.ts) from the same builder the seed uses
 * (backend/src/demo/build.ts). No backend, database, Docker, Whisper or
 * Gemini: one Vite dev server and one headless chromium, which is the
 * lightest way to get pixel-accurate pages on a small laptop.
 */
const port = Number(process.env.SCREENSHOTS_PORT ?? 5211);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.shots\.ts$/,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  },
  webServer: {
    command: `npm --prefix ../../frontend run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_API_URL: API_BASE, VITE_DEVICE_TOKEN: "" },
  },
});
