import { describe, expect, it } from "vitest";
import { containsAll, dueCorrect, matchExpected, ownerCorrect, supportRatio, trapHits } from "../src/match";
import type { ExpectedItem } from "../src/types";
import { item } from "./helpers";

const task = (over: Partial<ExpectedItem> = {}): ExpectedItem => ({
  id: "t1",
  kind: "actionItem",
  match: ["endpoint"],
  owner: "Marcus",
  dueDate: "Friday",
  dueResolved: "2026-11-13",
  evidenceStartMs: [0],
  ...over,
});

describe("containsAll", () => {
  it("needs every term, case-insensitive", () => {
    expect(containsAll("Build the Search ENDPOINT", ["endpoint", "search"])).toBe(true);
    expect(containsAll("Build the endpoint", ["endpoint", "search"])).toBe(false);
  });
});

describe("matchExpected", () => {
  it("matches one-to-one and only within the same kind", () => {
    const produced = [
      item({ ref: "d", kind: "decision", text: "endpoint decision" }),
      item({ ref: "a", kind: "actionItem", text: "endpoint and migration" }),
    ];
    const expected = [task({ id: "t1" }), task({ id: "t2", match: ["migration"] })];
    const assignment = matchExpected(expected, produced);
    expect(assignment.get("t1")).toBe("a");
    // The same produced item cannot answer a second expected item.
    expect(assignment.has("t2")).toBe(false);
  });

  it("applies judge pairs only to unmatched items of the same kind", () => {
    const produced = [item({ ref: "a", kind: "actionItem", text: "build the API route" }), item({ ref: "q", kind: "openQuestion", text: "x" })];
    const assignment = matchExpected([task()], produced, [
      { expectedId: "t1", ref: "q" },
      { expectedId: "t1", ref: "a" },
    ]);
    expect(assignment.get("t1")).toBe("a");
  });
});

describe("owner and deadline checks", () => {
  it("owner must be equal, not merely contained", () => {
    expect(ownerCorrect(task(), item({ kind: "actionItem", text: "", owner: " marcus " }))).toBe(true);
    expect(ownerCorrect(task(), item({ kind: "actionItem", text: "", owner: "Marcus and Lena" }))).toBe(false);
    expect(ownerCorrect(task({ owner: null }), item({ kind: "actionItem", text: "", owner: "Marcus" }))).toBe(false);
    expect(ownerCorrect(task({ owner: null }), item({ kind: "actionItem", text: "", owner: null }))).toBe(true);
  });

  it("deadline needs the spoken phrase and the exact resolved date", () => {
    const ok = item({ kind: "actionItem", text: "", dueSpoken: "by Friday", dueDate: "2026-11-13" });
    expect(dueCorrect(task(), ok)).toBe(true);
    expect(dueCorrect(task(), { ...ok, dueDate: "2026-11-20" })).toBe(false);
    expect(dueCorrect(task(), { ...ok, dueSpoken: "next week" })).toBe(false);
    // null in the key: inventing a deadline is wrong.
    expect(dueCorrect(task({ dueDate: null }), ok)).toBe(false);
    expect(dueCorrect(task({ dueDate: null }), { ...ok, dueSpoken: null })).toBe(true);
  });
});

describe("trapHits", () => {
  it("'any' traps apply to every kind, others only to theirs", () => {
    const traps = [
      { id: "rain", kind: "any", match: ["rain"], reason: "x" },
      { id: "dark", kind: "actionItem", match: ["dark mode"], reason: "x" },
    ];
    expect(trapHits(item({ kind: "decision", text: "It will rain" }), traps).map((t) => t.id)).toEqual(["rain"]);
    expect(trapHits(item({ kind: "decision", text: "dark mode parked" }), traps)).toEqual([]);
    expect(trapHits(item({ kind: "actionItem", text: "Ship dark mode" }), traps).map((t) => t.id)).toEqual(["dark"]);
  });
});

describe("supportRatio", () => {
  const ordered = [
    { idx: 0, text: "Small talk about the weekend." },
    { idx: 1, text: "Marcus will build the search endpoint." },
    { idx: 2, text: "By Friday, yes." },
  ];

  it("is high when the cited lines (and neighbours) carry the words", () => {
    expect(supportRatio(item({ kind: "actionItem", text: "Marcus builds the search endpoint by Friday", evidence: [1] }), ordered)).toBe(1);
  });

  it("is low for words that appear nowhere near the citation", () => {
    expect(supportRatio(item({ kind: "actionItem", text: "Migrate billing database to Oracle", evidence: [1] }), ordered)).toBeLessThan(0.5);
  });
});
