import { describe, expect, it } from "vitest";
import {
  isOverdue,
  isValidTimezone,
  normalizePhrase,
  offsetMinutes,
  resolveSpokenDate,
} from "../../src/lib/dates";

// Monday 9 November 2026, 10:00 in New York (15:00 UTC).
const ny = {
  meetingStart: new Date("2026-11-09T15:00:00Z"),
  timezone: "America/New_York",
};

const cases: [string, string | null][] = [
  ["Friday", "2026-11-13"],
  ["by Friday", "2026-11-13"],
  ["this Friday", "2026-11-13"],
  ["tomorrow", "2026-11-10"],
  ["today", "2026-11-09"],
  ["EOD", "2026-11-09"],
  ["end of day", "2026-11-09"],
  ["next Tuesday", "2026-11-17"],
  ["next Tuesday before class", "2026-11-17"],
  ["by next Tuesday", "2026-11-17"],
  ["end of the week", "2026-11-13"],
  ["end of this week", "2026-11-13"],
  ["end of next week", "2026-11-20"],
  ["by the end of next week", "2026-11-20"],
  ["end of the month", "2026-11-30"],
  ["end of next month", "2026-12-31"],
  ["in two weeks", "2026-11-23"],
  ["in 3 days", "2026-11-12"],
  ["March 3", "2027-03-03"],
  ["December 1st at 5pm", "2026-12-01"],
  ["2026-12-01", "2026-12-01"],
  ["Monday", "2026-11-16"], // the meeting's own weekday means next week
  ["Wednesday", "2026-11-11"],
  ["next sprint", null],
  ["next month", null],
  ["next week", null],
  ["soon", null],
  ["Q3", null],
  ["whenever you get a chance", null],
  ["", null],
];

describe("resolveSpokenDate", () => {
  it.each(cases)(
    "%s -> %s",
    (phrase, expected) => {
      expect(resolveSpokenDate(phrase, ny)).toBe(expected);
    }
  );

  it("returns null for null and undefined", () => {
    expect(resolveSpokenDate(null, ny)).toBeNull();
    expect(resolveSpokenDate(undefined, ny)).toBeNull();
  });

  it("returns null for an invalid meeting start", () => {
    expect(
      resolveSpokenDate("tomorrow", { meetingStart: new Date("nope") })
    ).toBeNull();
  });

  it("uses the meeting's timezone to decide which day 'tomorrow' is", () => {
    // 23:30 UTC on Monday is already Tuesday in Tokyo.
    const start = new Date("2026-11-09T23:30:00Z");

    expect(
      resolveSpokenDate("tomorrow", { meetingStart: start, timezone: "UTC" })
    ).toBe("2026-11-10");
    expect(
      resolveSpokenDate("tomorrow", {
        meetingStart: start,
        timezone: "Asia/Tokyo",
      })
    ).toBe("2026-11-11");
  });

  it("falls back to UTC for an unknown timezone", () => {
    expect(
      resolveSpokenDate("tomorrow", {
        meetingStart: ny.meetingStart,
        timezone: "Mars/Olympus",
      })
    ).toBe("2026-11-10");
  });

  it("anchors weekdays to a meeting late in the week", () => {
    // Thursday 12 Nov 2026: "Friday" is the next day, "Monday" the 16th.
    const thursday = {
      meetingStart: new Date("2026-11-12T14:00:00Z"),
      timezone: "Europe/London",
    };

    expect(resolveSpokenDate("Friday", thursday)).toBe("2026-11-13");
    expect(resolveSpokenDate("Monday", thursday)).toBe("2026-11-16");
    expect(resolveSpokenDate("end of next week", thursday)).toBe(
      "2026-11-20"
    );
  });

  it("resolves across a month boundary", () => {
    const lateMonth = {
      meetingStart: new Date("2026-11-30T12:00:00Z"),
      timezone: "UTC",
    };

    expect(resolveSpokenDate("tomorrow", lateMonth)).toBe("2026-12-01");
    expect(resolveSpokenDate("end of the month", lateMonth)).toBe(
      "2026-11-30"
    );
  });
});

describe("date helpers", () => {
  it("strips deadline wrappers", () => {
    expect(normalizePhrase("  By  Friday ")).toBe("friday");
    expect(normalizePhrase("no later than Monday")).toBe("monday");
    expect(normalizePhrase("next Tuesday before class")).toBe(
      "next tuesday"
    );
  });

  it("computes offsets with daylight saving", () => {
    expect(
      offsetMinutes(new Date("2026-07-01T12:00:00Z"), "America/New_York")
    ).toBe(-240);
    expect(
      offsetMinutes(new Date("2026-12-01T12:00:00Z"), "America/New_York")
    ).toBe(-300);
    expect(offsetMinutes(new Date("2026-12-01T12:00:00Z"), "Asia/Kolkata")).toBe(
      330
    );
  });

  it("validates timezones", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
  });

  it("flags overdue ISO dates only", () => {
    const now = new Date("2026-11-13T12:00:00Z");

    expect(isOverdue("2026-11-12", now)).toBe(true);
    expect(isOverdue("2026-11-13", now)).toBe(false);
    expect(isOverdue("2026-11-20", now)).toBe(false);
    expect(isOverdue("Friday", now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });
});
