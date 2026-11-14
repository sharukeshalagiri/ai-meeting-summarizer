import { describe, expect, it } from "vitest";
import type { SpeakerSegment } from "../../types/w2-spk";
import {
  buildTurns,
  filterTurns,
  foldLabel,
  isHiddenTurn,
  isNoise,
  partRuns,
  speakerKey,
} from "./turns";

const seg = (
  idx: number,
  speaker: string,
  text: string,
  extra: Partial<SpeakerSegment> = {}
): SpeakerSegment => ({
  id: `s${idx}`,
  idx,
  speaker,
  text,
  startMs: idx * 1000,
  endMs: idx * 1000 + 900,
  timestamp: "00:00",
  ...extra,
});

describe("speakerKey and isNoise", () => {
  it("keys by profile id, else by label", () => {
    expect(speakerKey(seg(1, "Priya", "x", { speakerId: "p1" }))).toBe("p1");
    expect(speakerKey(seg(1, "Speaker 1", "x"))).toBe("label:Speaker 1");
  });

  it("treats only non-substantive labels as noise; null is not noise", () => {
    expect(isNoise(seg(1, "a", "x", { noiseLabel: "small_talk" }))).toBe(true);
    expect(isNoise(seg(1, "a", "x", { noiseLabel: "substantive" }))).toBe(false);
    expect(isNoise(seg(1, "a", "x", { noiseLabel: null }))).toBe(false);
    expect(isNoise(seg(1, "a", "x"))).toBe(false);
  });
});

describe("buildTurns", () => {
  const segments = [
    seg(0, "You", "Morning", { speakerId: "me", channel: "mic", noiseLabel: "small_talk" }),
    seg(1000, "Speaker 2", "Hi", { speakerId: "p2", noiseLabel: "small_talk" }),
    seg(1001, "Speaker 2", "The build is green", { speakerId: "p2", noiseLabel: "substantive" }),
    seg(2000, "Speaker 2", "and deployed", { speakerId: "p2" }),
    seg(2001, "You", "Great", { speakerId: "me", channel: "mic" }),
  ];

  it("merges consecutive segments of one speaker and keeps every part", () => {
    const turns = buildTurns(segments);
    expect(turns.map((t) => [t.speaker, t.parts.map((p) => p.idx)])).toEqual([
      ["You", [0]],
      ["Speaker 2", [1000, 1001, 2000]],
      ["You", [2001]],
    ]);
    expect(turns[0].isMe).toBe(true);
  });

  it("applies name overrides by key", () => {
    const turns = buildTurns(segments, { names: new Map([["p2", "Priya"]]) });
    expect(turns[1].speaker).toBe("Priya");
  });

  it("hides noise without dropping its segments", () => {
    const turns = buildTurns(segments, { hideNoise: true });
    expect(isHiddenTurn(turns[0])).toBe(true);
    expect([...turns[1].hiddenIdx]).toEqual([1000]);
    // Every idx is still present for the seg-<idx> contract.
    expect(turns.flatMap((t) => t.parts.map((p) => p.idx))).toEqual([0, 1000, 1001, 2000, 2001]);
  });

  it("a revealed segment is shown despite the filter", () => {
    const turns = buildTurns(segments, { hideNoise: true, revealed: new Set([1000]) });
    expect(turns[1].hiddenIdx.size).toBe(0);
  });

  it("splits a turn into hidden and visible runs in order", () => {
    const [, priya] = buildTurns(segments, { hideNoise: true });
    expect(partRuns(priya).map((r) => [r.hidden, r.parts.length])).toEqual([
      [true, 1],
      [false, 2],
    ]);
  });
});

describe("filterTurns and foldLabel", () => {
  it("searches speaker names and every part", () => {
    const turns = buildTurns([
      seg(0, "Priya", "deploy plan", { speakerId: "p" }),
      seg(1, "Raj", "lunch?", { speakerId: "r", noiseLabel: "small_talk" }),
    ]);
    expect(filterTurns(turns, "raj").map((t) => t.speaker)).toEqual(["Raj"]);
    expect(filterTurns(turns, "lunch").map((t) => t.speaker)).toEqual(["Raj"]);
    expect(filterTurns(turns, "  ")).toHaveLength(2);
  });

  it("names a fold by its label", () => {
    expect(foldLabel([seg(0, "a", "x", { noiseLabel: "small_talk" })])).toBe("1 line of small talk");
    expect(
      foldLabel([
        seg(0, "a", "x", { noiseLabel: "filler" }),
        seg(1, "a", "y", { noiseLabel: "logistics" }),
      ])
    ).toBe("2 lines hidden");
  });
});
