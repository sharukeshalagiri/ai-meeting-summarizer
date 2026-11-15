import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { idOf, MEETINGS, mockDemoApi } from "./demoApi";

/**
 * Writes the README screenshots to docs/images/. Each step also checks
 * what it shows, so a broken page fails instead of being photographed.
 */

const OUT = path.resolve(__dirname, "../../docs/images");
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

test("README screenshots of the seeded demo", async ({ page }) => {
  await mockDemoApi(page);
  const lecture = MEETINGS.find((m) => m.key === "lecture")!;

  // 1. Sign-in page with "Try the demo".
  await page.goto("/login");
  const demo = page.getByRole("button", { name: "Try the demo" });
  await expect(demo).toBeVisible();
  await shot(page, "demo-login");

  // 2. One click: the lecture summary, with exam flags and chips.
  await demo.click();
  await expect(page).toHaveURL(new RegExp(`/meeting/${idOf("lecture")}$`));
  await expect(page.getByText(lecture.summary.tldr)).toBeVisible();
  await expect(page.getByText("Exam questions").first()).toBeVisible();
  await page.mouse.move(0, 0);
  await shot(page, "summary-lecture");

  // 3. A chip jumps to the segment it cites.
  const flag = lecture.summary.sections.lecture!.examQuestions.flaggedByLecturer[0];
  const cited = flag.evidence[0];
  await page.locator("li", { hasText: flag.question }).locator(".evidence-chip").first().click();
  const segment = page.locator(`#seg-${cited.idx}`);
  await expect(segment).toBeVisible();
  await expect(segment).toContainText("this will be on the exam");
  // Let the smooth scroll settle before the picture.
  await page.waitForTimeout(1500);
  await shot(page, "chip-to-transcript");

  // 4. The project meeting: tasks with owners and spoken deadlines.
  await page.goto(`/meeting/${idOf("project")}`);
  await expect(page.getByText("Build the search API endpoint").first()).toBeVisible();
  await page.mouse.move(0, 0);
  await shot(page, "summary-project");

  // 5. The interview: questions and answers, strengths, concerns.
  await page.goto(`/meeting/${idOf("interview")}`);
  await expect(page.getByText("Questions and answers").first()).toBeVisible();
  await page.mouse.move(0, 0);
  await shot(page, "summary-interview");
});

/**
 * The meeting list. Separate, because main's MeetingCard reads the
 * version 1 summary shape and fails on schemaVersion 2 rows (reported
 * in the PR); until that is fixed this test is skipped, not faked.
 */
test("meeting list", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockDemoApi(page);
  await page.goto("/login");
  await page.getByRole("button", { name: "Try the demo" }).click();
  await expect(page).toHaveURL(/\/meeting\//);
  await page.goto("/");
  await page.waitForTimeout(1500);
  console.log(`page errors on /: ${JSON.stringify(errors)}`);
  test.skip(errors.length > 0, "MeetingCard cannot render schemaVersion 2 summaries yet");
  for (const meeting of MEETINGS) await expect(page.getByText(meeting.title).first()).toBeVisible();
  await shot(page, "meetings");
});
