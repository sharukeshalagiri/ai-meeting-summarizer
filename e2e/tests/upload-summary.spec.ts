import { expect, test } from "@playwright/test";
import { MEETING_ID, SUMMARY_V2, SUMMARY_V2_RESUMMARIZED, mockApi } from "./mockApi";

/**
 * Upload -> queued pipeline (POST /process, progress over SSE) -> meeting
 * page, and a queued re-summarize, with the API mocked
 * in the browser. The "audio" is a few synthetic bytes: the mocked
 * backend never decodes it.
 */

const fakeAudio = { name: "standup.wav", mimeType: "audio/wav", buffer: Buffer.from("RIFF-e2e-not-real-audio") };

test("uploading a recording leads to its summary", async ({ page }) => {
  const { calls } = await mockApi(page, { title: "Search planning" });

  await page.goto("/new");
  await page.getByLabel("Meeting title").fill("Search planning");
  await page.locator("#audio").setInputFiles(fakeAudio);
  await page.getByRole("button", { name: "Upload Meeting" }).click();

  await expect(page).toHaveURL(new RegExp(`/meeting/${MEETING_ID}$`));
  await expect(page.getByText(SUMMARY_V2.tldr)).toBeVisible();
  await expect(page.getByText("Build the search endpoint").first()).toBeVisible();

  // The UI creates, uploads, then queues the whole pipeline once.
  const steps = calls.filter((c) => c.startsWith("POST"));
  expect(steps).toEqual([
    "POST /meetings",
    `POST /meetings/${MEETING_ID}/audio`,
    `POST /meetings/${MEETING_ID}/process`,
  ]);
  expect(calls).toContain(`GET /meetings/${MEETING_ID}/events`);
});

test("a re-summarize that outlives the request is followed to its result", async ({ page }) => {
  const { calls } = await mockApi(page, { title: "Search planning", summarized: true, resummarizeQueued: true });

  await page.goto(`/meeting/${MEETING_ID}`);
  await expect(page.getByText(SUMMARY_V2.tldr)).toBeVisible();

  await page.getByRole("button", { name: "Re-summarize" }).click();

  // { queued: true, summary: null } must not crash the view: it follows
  // the progress stream and swaps in the new summary when DONE.
  await expect(page.getByText(SUMMARY_V2_RESUMMARIZED.tldr)).toBeVisible();
  await expect(page.getByText(SUMMARY_V2.tldr)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Re-summarize" })).toBeEnabled();
  expect(calls).toContain(`GET /meetings/${MEETING_ID}/events`);
});

test("an AI outage is shown to the user, not swallowed", async ({ page }) => {
  await mockApi(page, { title: "Search planning", failStep: "summarize", failMessage: "The AI service is temporarily overloaded. Please try again in a minute." });

  await page.goto("/new");
  await page.getByLabel("Meeting title").fill("Search planning");
  await page.locator("#audio").setInputFiles(fakeAudio);
  await page.getByRole("button", { name: "Upload Meeting" }).click();

  await expect(page.getByRole("alert")).toContainText("temporarily overloaded");
  await expect(page).toHaveURL(/\/new$/);
});
