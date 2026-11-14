import { describe, expect, it } from "vitest";
import {
  applyAutoNames,
  attributeChunk,
  linkSegmentSpeakers,
  type SpeakerDeps,
} from "../../src/services/speakers/attribute";
import type {
  DiarizationOutput,
  DiarizationProvider,
} from "../../src/types/providers";

/** In-memory deps; no database, no network. */
const makeDeps = (
  provider: Partial<DiarizationProvider> & { diarize: DiarizationProvider["diarize"] },
  fallback?: DiarizationProvider["diarize"]
) => {
  const profiles: {
    id: string;
    meetingId: string;
    label: string;
    displayName: string | null;
    centroid: number[];
    source: string;
  }[] = [];
  const rows: {
    idx: number;
    speakerId: string | null;
    speaker: string;
    channel: string | null;
    text: string;
  }[] = [];
  let n = 0;

  const deps: SpeakerDeps = {
    profiles: {
      findByMeetingId: (async () => profiles.map((p) => ({ ...p }))) as never,
      create: (async (data: { meetingId: string; label: string; centroid?: number[] }) => {
        if (profiles.some((p) => p.label === data.label)) throw new Error("duplicate label");
        // Yield, so concurrent callers interleave like real I/O.
        await new Promise((r) => setTimeout(r, 1));
        const p = {
          id: `p${++n}`,
          meetingId: data.meetingId,
          label: data.label,
          displayName: null,
          centroid: data.centroid ?? [],
          source: "DIARIZATION",
        };
        profiles.push(p);
        return { ...p };
      }) as never,
      updateCentroid: (async (id: string, centroid: number[]) => {
        profiles.find((p) => p.id === id)!.centroid = centroid;
      }) as never,
      setDisplayName: (async (id: string, name: string) => {
        profiles.find((p) => p.id === id)!.displayName = name;
      }) as never,
      assignSegments: (async (_m: string, links: { idx: number; speakerId: string }[]) => {
        links.forEach((l) => {
          const row = rows.find((r) => r.idx === l.idx);
          if (row) row.speakerId = l.speakerId;
        });
        return links.length;
      }) as never,
      renameSegmentsOf: (async (_m: string, id: string, speaker: string) => {
        rows.filter((r) => r.speakerId === id).forEach((r) => (r.speaker = speaker));
        return 0;
      }) as never,
    },
    segments: { findByMeetingId: (async () => rows) as never },
    provider: () => ({ name: "voice", ...provider }) as DiarizationProvider,
    fallback: () =>
      ({
        name: "text",
        diarize:
          fallback ??
          (async () => {
            throw new Error("gemini down");
          }),
      }) as DiarizationProvider,
  };

  return { deps, profiles, rows };
};

const oneCluster = (centroid: number[]): DiarizationProvider["diarize"] =>
  async (request): Promise<DiarizationOutput> => ({
    segments: request.segments.map((s) => ({ ...s, speaker: "c0", speakerLabel: "c0" })),
    speakers: [{ label: "c0", displayName: null, centroid }],
  });

const seg = (text: string, startMs: number, channel?: "mic" | "remote") => ({
  text,
  startMs,
  endMs: startMs + 2000,
  ...(channel ? { channel } : {}),
});

describe("attributeChunk", () => {
  it("every mic segment is the user; only remote segments go to the provider", async () => {
    const seen: number[] = [];
    const { deps, profiles } = makeDeps({
      diarize: async (request) => {
        seen.push(request.segments.length);
        return oneCluster([1, 0])(request);
      },
    });

    const result = await attributeChunk(
      [seg("hello", 0, "mic"), seg("hi there", 2000, "remote"), seg("so", 4000, "mic")],
      { meetingId: "m", channelLayout: "stereo-mic-left", offsetMs: 0, filePath: "x" },
      deps
    );

    expect(result.map((s) => s.speaker)).toEqual(["You", "Speaker 1", "You"]);
    expect(seen).toEqual([1]);
    expect(profiles.map((p) => p.label).sort()).toEqual(["Speaker 1", "mic"]);
  });

  it("when voice and text both fail, the chunk continues the previous remote speaker", async () => {
    const { deps } = makeDeps({
      diarize: async () => {
        throw new Error("ai-service down");
      },
    });

    const first = await attributeChunk([seg("a", 0, "remote")], { meetingId: "m" }, deps);
    const second = await attributeChunk(
      [seg("b", 20_000, "remote")],
      {
        meetingId: "m",
        offsetMs: 20_000,
        previous: [{ speaker: first[0].speaker, text: "a", channel: "remote", speakerId: first[0].speakerId }],
      },
      deps
    );

    expect(second[0].speakerId).toBe(first[0].speakerId);
  });

  it("segments too short to embed join the nearest attributed segment", async () => {
    const { deps } = makeDeps({
      diarize: async (request) => ({
        segments: request.segments.map((s, i) => ({
          ...s,
          speaker: i === 1 ? "" : "c0",
          speakerLabel: i === 1 ? "" : "c0",
        })),
        speakers: [{ label: "c0", displayName: null, centroid: [1, 0] }],
      }),
    });

    const result = await attributeChunk(
      [seg("long answer", 0, "remote"), seg("yes", 2100, "remote")],
      { meetingId: "m", offsetMs: 0 },
      deps
    );
    expect(result[1].speakerId).toBe(result[0].speakerId);
  });

  it("concurrent chunks of one meeting never create duplicate profiles", async () => {
    const { deps, profiles } = makeDeps({ diarize: oneCluster([1, 0]) });

    await Promise.all(
      [0, 1, 2, 3].map((seq) =>
        attributeChunk(
          [seg(`chunk ${seq}`, seq * 20_000, "remote")],
          { meetingId: "m", offsetMs: seq * 20_000 },
          deps
        )
      )
    );

    expect(profiles.map((p) => p.label)).toEqual(["Speaker 1"]);
  });

  it("text labels map onto existing profiles by name", async () => {
    const labels = [["Priya"], ["Priya"]];
    const { deps, profiles } = makeDeps({
      name: "text",
      diarize: async (request) => {
        const [label] = labels.shift()!;
        return {
          segments: request.segments.map((s) => ({ ...s, speaker: label, speakerLabel: label })),
          speakers: [{ label, displayName: null, centroid: [] }],
        };
      },
    });

    const a = await attributeChunk([seg("one", 0, "remote")], { meetingId: "m" }, deps);
    const b = await attributeChunk([seg("two", 20_000, "remote")], { meetingId: "m" }, deps);
    expect(b[0].speakerId).toBe(a[0].speakerId);
    expect(profiles).toHaveLength(1);
  });
});

describe("linkSegmentSpeakers and applyAutoNames", () => {
  it("is a no-op for segments without a speakerId", async () => {
    const { deps } = makeDeps({ diarize: oneCluster([1, 0]) });
    let called = false;
    const spy = {
      ...deps,
      profiles: {
        ...deps.profiles,
        assignSegments: (async () => {
          called = true;
          return 0;
        }) as never,
      },
    };
    await linkSegmentSpeakers("m", [{ idx: 0, text: "hi" }], {}, spy);
    expect(called).toBe(false);
  });

  it("applies a name with two signals and never overrides a manual one", async () => {
    const { deps, profiles, rows } = makeDeps({ diarize: oneCluster([1, 0]) });
    const [attributed] = await attributeChunk(
      [seg("I'm Priya.", 0, "remote")],
      { meetingId: "m" },
      deps
    );
    rows.push({ idx: 0, speakerId: null, speaker: attributed.speaker, channel: "remote", text: "I'm Priya." });

    await linkSegmentSpeakers(
      "m",
      [{ idx: 0, speakerId: attributed.speakerId, text: "I'm Priya." }],
      { roster: ["Priya"] },
      deps
    );
    expect(profiles[0].displayName).toBe("Priya");
    expect(rows[0].speaker).toBe("Priya");

    profiles[0].displayName = "Dr. P";
    profiles[0].source = "MANUAL";
    expect(await applyAutoNames("m", ["Priya"], deps)).toEqual([]);
    expect(profiles[0].displayName).toBe("Dr. P");
  });

  it("one signal applies nothing", async () => {
    const { deps, profiles, rows } = makeDeps({ diarize: oneCluster([1, 0]) });
    const [a] = await attributeChunk([seg("I'm Priya.", 0, "remote")], { meetingId: "m" }, deps);
    rows.push({ idx: 0, speakerId: a.speakerId!, speaker: a.speaker, channel: "remote", text: "I'm Priya." });
    expect(await applyAutoNames("m", [], deps)).toEqual([]);
    expect(profiles[0].displayName).toBeNull();
  });
});
