import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSpokenDate } from "../../backend/src/lib/dates";
import { FIXTURE_DIR, listCases } from "../src/cases";
import type { AnswerKey } from "../src/types";
import { fixture } from "./helpers";

/**
 * Checks for the fields w2-eval added to answer keys (dueResolved, me,
 * counts, mayAppear). backend/test/fixtures.test.ts already checks every
 * key's transcript, evidence and match terms, and ignores these fields.
 */

const keys = fs
  .readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".expected.json"))
  .map((name) => name.replace(/\.expected\.json$/, ""));

const defaults = { meetingStart: new Date("2026-11-09T15:00:00Z"), timezone: "America/New_York" };

describe("synthetic cases", () => {
  it("has eight transcript cases (seven synthetic + the generated 90-minute one)", () => {
    const transcriptCases = listCases().filter((c) => c.type === "synthetic" || c.type === "generated");
    expect(transcriptCases.map((c) => c.id).sort()).toEqual(
      ["interview-candidate", "interview-interviewer", "lecture", "long-90min", "no-tasks", "noisy-smalltalk", "one-on-one", "project-meeting"].sort()
    );
    expect(keys.sort()).toEqual(transcriptCases.filter((c) => c.type === "synthetic").map((c) => c.id).sort());
  });

  it("marks exactly two smoke cases", () => {
    expect(listCases().filter((c) => c.smoke).map((c) => c.id)).toEqual(["project-meeting", "no-tasks"]);
  });
});

describe.each(keys)("answer key %s (w2-eval fields)", (name) => {
  const { key, segments }: { key: AnswerKey; segments: { speaker: string }[] } = fixture(name);

  it("dueResolved is a calendar date and agrees with lib/dates for the spoken phrase", () => {
    for (const item of key.mustAppear) {
      if (!item.dueResolved) continue;
      expect(item.dueResolved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.dueDate, `${item.id} has dueResolved without dueDate`).toBeTruthy();
      expect(resolveSpokenDate(item.dueDate!, defaults), item.id).toBe(item.dueResolved);
    }
  });

  it("me, when set, is a speaker", () => {
    if (key.me) expect(segments.map((s) => s.speaker)).toContain(key.me);
  });

  it("counts do not contradict mustAppear", () => {
    for (const [kind, count] of Object.entries(key.counts ?? {})) {
      expect(key.mustAppear.filter((i) => i.kind === kind).length).toBeLessThanOrEqual(count);
    }
  });
});
