import { describe, expect, it } from "vitest";
import {
  CONTINUITY_MS,
  MATCH_SIMILARITY,
  cosine,
  matchClusters,
  nextSpeakerLabel,
  updateCentroid,
} from "../../src/services/speakers/matcher";

const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

/** A unit vector at `deg` degrees from [1, 0]: cosine to it = cos(deg). */
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

const long = (centroid: number[], startMs = 0) => ({ centroid, speechMs: 5000, startMs });
const short = (centroid: number[], startMs = 0) => ({ centroid, speechMs: 600, startMs });

describe("cosine", () => {
  it("handles identical, orthogonal and mismatched vectors", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [1, 0, 0])).toBeNaN();
    expect(cosine([], [])).toBeNaN();
  });
});

describe("matchClusters", () => {
  it("cold start: every cluster is new", () => {
    expect(matchClusters([], [long(at(0)), long(at(90))], { chunkStartMs: 0 })).toEqual([
      { kind: "new" },
      { kind: "new" },
    ]);
  });

  it("matches a known voice above the threshold and updates it when unambiguous", () => {
    const [match] = matchClusters(
      [
        { id: "a", centroid: at(0) },
        { id: "b", centroid: at(90) },
      ],
      [long(at(20))],
      { chunkStartMs: 0 }
    );
    expect(match).toMatchObject({ kind: "match", profileId: "a", update: true });
  });

  it("creates a new speaker below the threshold", () => {
    const angle = (Math.acos(MATCH_SIMILARITY) * 180) / Math.PI + 5;
    expect(
      matchClusters([{ id: "a", centroid: at(0) }], [long(at(angle))], { chunkStartMs: 0 })
    ).toEqual([{ kind: "new" }]);
  });

  it("is one-to-one: two clusters cannot take the same profile", () => {
    const result = matchClusters(
      [{ id: "a", centroid: at(0) }],
      [long(at(10)), long(at(15))],
      { chunkStartMs: 0 }
    );
    expect(result[0]).toMatchObject({ kind: "match", profileId: "a" });
    expect(result[1]).toEqual({ kind: "new" });
  });

  it("an ambiguous match keeps the label but does not move the centroid", () => {
    const [match] = matchClusters(
      [
        { id: "a", centroid: at(0) },
        { id: "b", centroid: at(10) },
      ],
      [long(at(4))],
      { chunkStartMs: 0 }
    );
    expect(match).toMatchObject({ kind: "match", update: false });
  });

  it("a short cluster matches at the looser threshold and never updates", () => {
    const [match] = matchClusters([{ id: "a", centroid: at(0) }], [short(at(60))], {
      chunkStartMs: 0,
    });
    expect(match).toMatchObject({ kind: "match", profileId: "a", update: false });
  });

  it("a short, unrecognised cluster at the chunk start continues the previous speaker", () => {
    const options = { chunkStartMs: 20_000, previousSpeakerId: "a" };
    const profiles = [{ id: "a", centroid: at(0) }];

    expect(matchClusters(profiles, [short(at(80), 20_200)], options)[0]).toMatchObject({
      kind: "match",
      profileId: "a",
      update: false,
    });

    // Later in the chunk, continuity does not apply.
    expect(
      matchClusters(profiles, [short(at(80), 20_000 + CONTINUITY_MS + 500)], options)[0]
    ).toEqual({ kind: "new" });
  });

  it("an unmatched long cluster adopts a profile with no centroid yet", () => {
    const [match] = matchClusters(
      [
        { id: "voiced", centroid: at(0) },
        { id: "silent", centroid: [] },
      ],
      [long(at(90))],
      { chunkStartMs: 0 }
    );
    expect(match).toMatchObject({ kind: "match", profileId: "silent", adopted: true });
  });

  it("ignores profiles whose centroid has another dimension (model changed)", () => {
    expect(
      matchClusters([{ id: "a", centroid: [1, 0, 0] }], [long(at(0))], { chunkStartMs: 0 })
    ).toEqual([{ kind: "new" }]);
  });
});

describe("updateCentroid", () => {
  it("moves toward the new voice more for longer speech, capped at half", () => {
    const base = unit(1, 0);
    const incoming = unit(0, 1);
    const little = updateCentroid(base, incoming, 1000);
    const lots = updateCentroid(base, incoming, 10 * 60_000);
    expect(little[1]).toBeLessThan(lots[1]);
    expect(lots[0]).toBeCloseTo(lots[1]); // a = 0.5 cap
    expect(Math.hypot(...lots)).toBeCloseTo(1);
  });

  it("takes the incoming centroid when there is none", () => {
    expect(updateCentroid([], [3, 4], 1000)).toEqual([0.6, 0.8]);
  });
});

describe("nextSpeakerLabel", () => {
  it("continues after the highest Speaker N", () => {
    expect(nextSpeakerLabel([])).toBe("Speaker 1");
    expect(nextSpeakerLabel(["mic", "Speaker 1", "Speaker 3", "Priya"])).toBe("Speaker 4");
  });
});
