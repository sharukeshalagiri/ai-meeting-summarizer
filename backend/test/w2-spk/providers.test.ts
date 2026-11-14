import { describe, expect, it } from "vitest";
import {
  DeepgramDiarizationProvider,
  DiarizationUnavailable,
  TextDiarizationProvider,
  VoiceDiarizationProvider,
  parseDeepgramTurns,
  parseVoiceClusters,
  type ChunkDiarizationRequest,
} from "../../src/services/speakers/providers";

const request = (over: Partial<ChunkDiarizationRequest> = {}): ChunkDiarizationRequest => ({
  meetingId: "m",
  filePath: "uploads/live/chunk.webm",
  channelLayout: "stereo-mic-left",
  offsetMs: 20_000,
  segments: [
    { text: "a", startMs: 20_000, endMs: 23_000 },
    { text: "b", startMs: 23_000, endMs: 26_000 },
    { text: "c", startMs: 26_000, endMs: 26_300 },
  ],
  ...over,
});

describe("parseVoiceClusters", () => {
  it("drops out-of-range, duplicate and non-integer members", () => {
    expect(
      parseVoiceClusters(
        {
          clusters: [
            { members: [0, 5, 1.5, "x"], centroid: [1, 0] },
            { members: [0, 1], centroid: [0, 1] },
            { members: [], centroid: [0, 1] },
            { members: [2], centroid: ["bad"] },
          ],
        },
        3
      )
    ).toEqual([
      { members: [0], centroid: [1, 0] },
      { members: [1], centroid: [0, 1] },
      { members: [2], centroid: [] },
    ]);
  });

  it("rejects a malformed body", () => {
    expect(() => parseVoiceClusters({ nope: true }, 1)).toThrow();
  });
});

describe("VoiceDiarizationProvider", () => {
  it("posts remote spans with the chunk offset and maps clusters to labels", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const provider = new VoiceDiarizationProvider("http://ai:5152", async (url, body) => {
      calls.push({ url, body: body as Record<string, unknown> });
      return {
        data: {
          clusters: [
            { members: [0, 1], centroid: [1, 0] },
          ],
          skipped: [2],
        },
      };
    });

    const output = await provider.diarize(request());

    expect(calls[0].url).toBe("http://ai:5152/diarize");
    expect(calls[0].body).toMatchObject({
      offset_ms: 20_000,
      channel_layout: "stereo-mic-left",
      segments: [
        { startMs: 20_000, endMs: 23_000 },
        { startMs: 23_000, endMs: 26_000 },
        { startMs: 26_000, endMs: 26_300 },
      ],
    });
    expect(String(calls[0].body.file_path)).toMatch(/chunk\.webm$/);
    expect(output.segments.map((s) => s.speakerLabel)).toEqual(["c0", "c0", ""]);
    expect(output.speakers).toEqual([{ label: "c0", displayName: null, centroid: [1, 0] }]);
  });

  it("is unavailable without a file or when the service fails", async () => {
    const failing = new VoiceDiarizationProvider("http://ai", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(failing.diarize(request())).rejects.toBeInstanceOf(DiarizationUnavailable);
    await expect(failing.diarize(request({ filePath: null }))).rejects.toBeInstanceOf(
      DiarizationUnavailable
    );
  });
});

describe("TextDiarizationProvider", () => {
  it("passes context and known labels to the labeller", async () => {
    const received: unknown[] = [];
    const provider = new TextDiarizationProvider(async (segments, context, known) => {
      received.push(context, known);
      return segments.map(() => "Speaker 2");
    });

    const output = await provider.diarize(
      request({
        context: [{ speaker: "Speaker 2", text: "earlier" }],
        knownLabels: ["Speaker 2"],
      })
    );

    expect(received).toEqual([[{ speaker: "Speaker 2", text: "earlier" }], ["Speaker 2"]]);
    expect(output.speakers).toEqual([{ label: "Speaker 2", displayName: null, centroid: [] }]);
  });
});

describe("Deepgram diarization", () => {
  const body = {
    results: {
      utterances: [
        { speaker: 0, channel: 1, start: 0.0, end: 3.0 },
        { speaker: 1, channel: 1, start: 3.0, end: 6.4 },
        { speaker: 0, channel: 0, start: 0.0, end: 6.0 },
      ],
    },
  };

  it("keeps only the remote channel's turns, on the meeting timeline", () => {
    expect(parseDeepgramTurns(body, 20_000, 1)).toEqual([
      { speaker: 0, startMs: 20_000, endMs: 23_000 },
      { speaker: 1, startMs: 23_000, endMs: 26_400 },
    ]);
  });

  it("labels each segment with the most-overlapping Deepgram speaker", async () => {
    const provider = new DeepgramDiarizationProvider(
      "key",
      (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
    );
    // The provider reads the chunk file; point it at this test file.
    const output = await provider.diarize(request({ filePath: __filename }));
    expect(output.segments.map((s) => s.speakerLabel)).toEqual([
      "Speaker 1",
      "Speaker 2",
      "Speaker 2",
    ]);
    expect(output.speakers.every((s) => s.centroid.length === 0)).toBe(true);
  });

  it("is unavailable without a key", async () => {
    await expect(
      new DeepgramDiarizationProvider(null).diarize(request())
    ).rejects.toBeInstanceOf(DiarizationUnavailable);
  });
});
