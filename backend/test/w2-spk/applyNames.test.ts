import { describe, expect, it } from "vitest";
import {
  applyOwnerNames,
  applySpeakerNames,
  buildRenameMap,
} from "../../src/services/speakers/applyNames";

describe("buildRenameMap", () => {
  it("collapses chains and ignores no-ops", () => {
    const map = buildRenameMap([
      { from: "Speaker 2", to: "Pri" },
      { from: "Pri", to: "Priya" },
      { from: "Raj", to: "raj" },
    ]);
    expect(Object.fromEntries(map)).toEqual({ "speaker 2": "Priya", pri: "Priya" });
  });

  it("a rename back drops the stale entry", () => {
    const map = buildRenameMap([
      { from: "Speaker 2", to: "Priya" },
      { from: "Priya", to: "Speaker 2" },
    ]);
    expect(Object.fromEntries(map)).toEqual({ priya: "Speaker 2" });
  });
});

describe("applySpeakerNames", () => {
  const createdAt = new Date("2026-11-14T10:00:00Z");
  const meeting = {
    id: "m1",
    title: "Sync",
    createdAt,
    summary: {
      id: "s1",
      data: {
        schemaVersion: 2,
        actionItems: [
          {
            task: "Ship the migration",
            owner: "Speaker 2",
            evidence: [{ idx: 1003, speaker: "Speaker 2", startMs: 20_000 }],
          },
        ],
        decisions: [
          { text: "Use Postgres", evidence: [{ idx: 4, speaker: "Speaker 3", startMs: 1 }] },
        ],
        whoSaidWhat: [{ speaker: "speaker 2", text: "on track" }],
        tldr: "Speaker 2 will ship it.",
      },
    },
    actionItems: [
      { id: "a1", task: "Ship", owner: "Speaker 2", assignedBy: "You", createdAt },
    ],
  };

  const renames = buildRenameMap([{ from: "Speaker 2", to: "Priya" }]);
  const segmentSpeakers = new Map([
    [1003, "Priya"],
    [4, "Raj"],
  ]);

  it("projects names into summary evidence, owners and who-said-what", () => {
    const result = applySpeakerNames(meeting, renames, segmentSpeakers);
    const data = result.summary.data;

    expect(data.actionItems[0].owner).toBe("Priya");
    expect(data.actionItems[0].evidence[0].speaker).toBe("Priya");
    // Evidence follows the segment's current speaker, by idx.
    expect(data.decisions[0].evidence[0].speaker).toBe("Raj");
    expect(data.whoSaidWhat[0].speaker).toBe("Priya");
    expect(result.actionItems[0]).toMatchObject({ owner: "Priya", assignedBy: "You" });
  });

  it("leaves free text, other fields, dates and the input untouched", () => {
    const result = applySpeakerNames(meeting, renames, segmentSpeakers);
    expect(result.summary.data.tldr).toBe("Speaker 2 will ship it.");
    expect(result.actionItems[0].createdAt).toBe(createdAt);
    expect(result.createdAt).toBe(createdAt);
    expect(meeting.summary.data.actionItems[0].owner).toBe("Speaker 2");
  });

  it("returns the same object when there is nothing to rename", () => {
    expect(applySpeakerNames(meeting, new Map())).toBe(meeting);
  });

  it("handles a meeting without summary or action items", () => {
    const bare = { id: "m2", summary: null, actionItems: [] };
    expect(applySpeakerNames(bare, renames)).toEqual(bare);
  });
});

describe("applyOwnerNames", () => {
  it("renames per meeting", () => {
    const items = [
      { meetingId: "m1", owner: "Speaker 2" },
      { meetingId: "m2", owner: "Speaker 2" },
    ];
    const result = applyOwnerNames(
      items,
      new Map([["m1", buildRenameMap([{ from: "Speaker 2", to: "Priya" }])]])
    );
    expect(result.map((i) => i.owner)).toEqual(["Priya", "Speaker 2"]);
  });
});
