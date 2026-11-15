import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Meeting } from "../types/meeting";
import MeetingCard from "./MeetingCard";

/**
 * The meetings list must render for both stored summary versions. A v2
 * summary (schemaVersion 2) used to throw on v1 field names and blank
 * the whole page.
 */

const meeting = (data: unknown): Meeting =>
  ({
    id: "m1",
    title: "Search planning",
    description: null,
    status: "COMPLETED",
    source: "UPLOAD",
    platform: null,
    durationSec: 600,
    createdAt: "2026-11-09T15:00:00.000Z",
    processingStage: "DONE",
    transcript: { id: "t1", content: "" },
    summary: { id: "s1", content: "", data, sentiment: "POSITIVE" },
    actionItems: [{ id: "a1", status: "PENDING" }],
  }) as unknown as Meeting;

const render = (data: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <MeetingCard meeting={meeting(data)} />
    </MemoryRouter>
  );

describe("MeetingCard", () => {
  it("renders a v2 summary: TL;DR, decisions, project blockers", () => {
    const html = render({
      schemaVersion: 2,
      mode: "PROJECT",
      tldr: "Postgres full-text search for the beta.",
      decisions: [{ text: "Use Postgres FTS" }, { text: "Ship Friday" }],
      actionItems: [],
      sections: { project: { people: [{ name: "Marcus", done: [], next: [], blockers: [{ text: "No staging DB" }] }], risks: [] } },
    });

    expect(html).toContain("Postgres full-text search for the beta.");
    expect(html).toContain("2 decisions");
    expect(html).toContain("1 blocker");
    expect(html).toContain("1 open");
  });

  it("still renders a v1 summary", () => {
    const html = render({ executiveSummary: "Old format.", keyDecisions: ["One"], blockers: [] });

    expect(html).toContain("Old format.");
    expect(html).toContain("1 decision");
    expect(html).not.toContain("blocker");
  });

  it("survives a summary with missing fields", () => {
    expect(() => render({})).not.toThrow();
  });
});
