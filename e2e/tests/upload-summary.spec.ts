import { expect, test } from "@playwright/test";
import { MEETING_ID, SUMMARY_V2, mockApi } from "./mockApi";

/**
 * Upload -> transcribe -> summarize -> meeting page, with the API mocked
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

  // The UI calls the pipeline steps in order, each exactly once.
  const steps = calls.filter((c) => c.startsWith("POST"));
  expect(steps).toEqual([
    "POST /meetings",
    `POST /meetings/${MEETING_ID}/audio`,
    `POST /meetings/${MEETING_ID}/transcribe`,
    `POST /meetings/${MEETING_ID}/summarize`,
  ]);
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
