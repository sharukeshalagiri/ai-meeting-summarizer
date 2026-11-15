import { describe, expect, it } from "vitest";
import {
  applyAutoNames,
  attributeChunk,
  linkSegmentSpeakers,
  splitByProfile,
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

/** "Hi I am Priya ... | Sam here ..." as one Whisper segment with words. */
const twoVoiceSegment = () => {
  const words = [
    ["Hi,", 0], ["I", 400], ["am", 800], ["Priya.", 1200], ["All", 1600], ["done.", 2000],
    // 1 s pause, then another voice in the SAME Whisper segment
    ["Thanks.", 3400], ["The", 3800], ["migration", 4200], ["is", 4600], ["late.", 5000],
  ].map(([w, startMs]) => ({ w: w as string, startMs: startMs as number, endMs: (startMs as number) + 350 }));
  return {
    text: words.map((w) => w.w).join(" "),
    startMs: 0,
    endMs: 5350,
    channel: "remote" as const,
    words,
  };
};

describe("one Whisper segment, two voices", () => {
  it("becomes two speakers, split at the piece boundary, in time order", async () => {
    const { deps, profiles } = makeDeps({
      diarize: async (request) => ({
        segments: request.segments.map((s) => ({ ...s, speaker: "c0", speakerLabel: "c0" })),
        pieces: [
          { segment: 0, startMs: 0, endMs: 2350, speakerLabel: "c0" },
          { segment: 0, startMs: 3400, endMs: 5350, speakerLabel: "c1" },
        ],
        speakers: [
          { label: "c0", displayName: null, centroid: [1, 0, 0] },
          { label: "c1", displayName: null, centroid: [0, 1, 0] },
        ],
      }),
    });

    const result = await attributeChunk(
      [seg("before", -3000, "mic"), twoVoiceSegment()],
      { meetingId: "m", offsetMs: 0, filePath: "x" },
      deps
    );

    expect(result.map((s) => [s.speaker, s.text, s.startMs])).toEqual([
      ["You", "before", -3000],
      ["Speaker 1", "Hi, I am Priya. All done.", 0],
      ["Speaker 2", "Thanks. The migration is late.", 3400],
    ]);
    expect(result[1].speakerId).not.toBe(result[2].speakerId);
    expect(result[2].words?.map((w) => w.w)).toEqual(["Thanks.", "The", "migration", "is", "late."]);
    expect(profiles.filter((p) => p.label !== "mic")).toHaveLength(2);
  });

  it("pieces of one voice merge back into the original segment", async () => {
    const original = twoVoiceSegment();
    const { deps } = makeDeps({
      diarize: async (request) => ({
        segments: request.segments.map((s) => ({ ...s, speaker: "c0", speakerLabel: "c0" })),
        pieces: [
          { segment: 0, startMs: 0, endMs: 2350, speakerLabel: "c0" },
          { segment: 0, startMs: 3400, endMs: 5350, speakerLabel: "c0" },
        ],
        speakers: [{ label: "c0", displayName: null, centroid: [1, 0, 0] }],
      }),
    });

    const result = await attributeChunk([original], { meetingId: "m" }, deps);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(original.text);
  });
});

describe("splitByProfile", () => {
  const a = { id: "a" };
  const b = { id: "b" };

  it("assigns each word by its midpoint; a piece extends to the next one's start", () => {
    const parts = splitByProfile(twoVoiceSegment(), [
      { startMs: 0, endMs: 1000, profile: a },
      { startMs: 1500, endMs: 2350, profile: b },
      { startMs: 3400, endMs: 5350, profile: b },
    ]);
    expect(parts.map((p) => [p.profile.id, p.segment.text])).toEqual([
      // "Priya." spans 1200-1550: its midpoint (1375) is before 1500.
      ["a", "Hi, I am Priya."],
      ["b", "All done. Thanks. The migration is late."],
    ]);
  });

  it("without word timings, gives the whole segment to the longest piece", () => {
    const { words: _w, ...noWords } = twoVoiceSegment();
    const parts = splitByProfile(noWords, [
      { startMs: 0, endMs: 1000, profile: a },
      { startMs: 1000, endMs: 5000, profile: b },
    ]);
    expect(parts).toEqual([{ segment: noWords, profile: b }]);
  });
});
