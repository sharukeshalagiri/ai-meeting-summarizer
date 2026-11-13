import { describe, expect, it } from "vitest";
import { parseSegments } from "../src/services/speech.service";

describe("parseSegments", () => {
  it("returns an empty list for anything that is not an array", () => {
    expect(parseSegments(undefined)).toEqual([]);
    expect(parseSegments(null)).toEqual([]);
    expect(parseSegments({ text: "hi" })).toEqual([]);
    expect(parseSegments("segments")).toEqual([]);
  });

  it("keeps valid segments, trimming text and rounding times", () => {
    expect(
      parseSegments([
        { text: "  Hello there. ", startMs: 0, endMs: 1499.6 },
        { text: "Next", startMs: "1500", endMs: "2400" },
      ])
    ).toEqual([
      { text: "Hello there.", startMs: 0, endMs: 1500 },
      { text: "Next", startMs: 1500, endMs: 2400 },
    ]);
  });

  it("strips fields other than text and timing", () => {
    const [segment] = parseSegments([
      { text: "a", startMs: 0, endMs: 10, noSpeechProb: 0.1, extra: true },
    ]);

    expect(Object.keys(segment).sort()).toEqual(["endMs", "startMs", "text"]);
  });

  it("drops segments with empty text, bad timing, or wrong type", () => {
    expect(
      parseSegments([
        { text: "   ", startMs: 0, endMs: 10 },
        { text: "no start", endMs: 10 },
        { text: "nan", startMs: "abc", endMs: 10 },
        { text: 5, startMs: 0, endMs: 10 },
        null,
        "string",
      ])
    ).toEqual([]);
  });

  it("drops likely hallucinations above the no-speech threshold", () => {
    const result = parseSegments([
      { text: "Thank you.", startMs: 0, endMs: 900, noSpeechProb: 0.9 },
      { text: "Real speech", startMs: 900, endMs: 2000, noSpeechProb: 0.75 },
      { text: "Also kept", startMs: 2000, endMs: 3000, noSpeechProb: "n/a" },
    ]);

    expect(result.map((s) => s.text)).toEqual(["Real speech", "Also kept"]);
  });

  it("clamps negative starts and inverted spans", () => {
    expect(
      parseSegments([
        { text: "negative", startMs: -50, endMs: 100 },
        { text: "inverted", startMs: 5000, endMs: 4000 },
      ])
    ).toEqual([
      { text: "negative", startMs: 0, endMs: 100 },
      { text: "inverted", startMs: 5000, endMs: 5000 },
    ]);
  });
});
