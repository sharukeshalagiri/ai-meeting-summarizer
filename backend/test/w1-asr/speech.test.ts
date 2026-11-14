import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    default: { ...actual.default, post: vi.fn(), isAxiosError: actual.default.isAxiosError },
  };
});

import axios from "axios";
import {
  combineHints,
  parseSegments,
  transcribeAudioDetailed,
} from "../../src/services/speech.service";

const post = vi.mocked(axios.post);

describe("parseSegments (w1-asr)", () => {
  it("keeps channel and words in the stored word shape", () => {
    const [segment] = parseSegments([
      {
        text: " I'll send it ",
        startMs: 1000,
        endMs: 2000,
        noSpeechProb: 0.02,
        channel: "mic",
        words: [
          { w: " I'll", startMs: 1000, endMs: 1300, p: 0.91 },
          { w: "send", startMs: 1300, endMs: 1600, p: 1.4 },
          { w: "it", startMs: 1600, endMs: 2000 },
          { w: "", startMs: 0, endMs: 1 },
          { w: "bad", startMs: "x", endMs: 1 },
          null,
        ],
      },
    ]);

    expect(segment).toEqual({
      text: "I'll send it",
      startMs: 1000,
      endMs: 2000,
      channel: "mic",
      words: [
        { w: "I'll", startMs: 1000, endMs: 1300, p: 0.91 },
        { w: "send", startMs: 1300, endMs: 1600, p: 1 },
        { w: "it", startMs: 1600, endMs: 2000 },
      ],
    });
  });

  it("ignores unknown channels and empty word lists", () => {
    const [segment] = parseSegments([
      { text: "hi", startMs: 0, endMs: 10, channel: "left", words: [] },
    ]);
    expect(segment).toEqual({ text: "hi", startMs: 0, endMs: 10 });
  });
});

describe("combineHints", () => {
  it("puts roster names first and de-duplicates case-insensitively", () => {
    expect(
      combineHints(["Priya Shah", "Marcus"], ["Kubernetes", "marcus", " ", "Q3"])
    ).toEqual(["Priya Shah", "Marcus", "Kubernetes", "Q3"]);
    expect(combineHints()).toEqual([]);
  });
});

describe("transcribeAudioDetailed with the local provider", () => {
  // Block body on purpose: vitest runs a function returned from a hook
  // as teardown, and mockReset() returns the mock itself.
  beforeEach(() => {
    post.mockReset();
  });

  it("keeps the two-argument form: mono, no hints", async () => {
    post.mockResolvedValue({
      data: { text: "hello", segments: [{ text: "hello", startMs: 0, endMs: 500 }], durationMs: 900, language: "en" },
    });

    const result = await transcribeAudioDetailed("uploads/a.webm", 5000);

    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/transcribe$/);
    expect(body).toMatchObject({ offset_ms: 5000, channel_layout: "mono", hints: [], previous_words: [] });
    expect((body as { file_path: string }).file_path).toMatch(/uploads[\\/]a\.webm$/);
    expect(result).toEqual({
      text: "hello",
      segments: [{ text: "hello", startMs: 0, endMs: 500 }],
      durationMs: 900,
      language: "en",
      provider: "local",
    });
  });

  it("sends layout, roster + hints and the previous chunk's tail words", async () => {
    post.mockResolvedValue({
      data: {
        text: "a b",
        segments: [
          { text: "a", startMs: 0, endMs: 1, channel: "mic", words: [{ w: "a", startMs: 0, endMs: 1, p: 0.5 }] },
          { text: "b", startMs: 1, endMs: 2, channel: "remote" },
        ],
        durationMs: 2,
        language: null,
      },
    });

    const previous = Array.from({ length: 20 }, (_, i) => ({
      w: `w${i}`,
      startMs: i * 100,
      endMs: i * 100 + 90,
      channel: i % 2 ? "remote" : "mic",
    }));

    const result = await transcribeAudioDetailed("x.webm", 0, {
      channelLayout: "stereo-mic-left",
      roster: ["Priya"],
      hints: ["Kubernetes", "priya"],
      language: "en",
      previousWords: previous,
    });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.channel_layout).toBe("stereo-mic-left");
    expect(body.hints).toEqual(["Priya", "Kubernetes"]);
    expect(body.language).toBe("en");
    const sent = body.previous_words as { w: string; channel: string }[];
    expect(sent).toHaveLength(12);
    expect(sent[0]).toEqual({ w: "w8", startMs: 800, endMs: 890, channel: "mic" });
    expect(result.segments.map((s) => s.channel)).toEqual(["mic", "remote"]);
    expect(result.segments[0].words).toEqual([{ w: "a", startMs: 0, endMs: 1, p: 0.5 }]);
  });

  it("maps upstream failures to a 502 AppError", async () => {
    post.mockRejectedValue(
      new axios.AxiosError("connect ECONNREFUSED", "ECONNREFUSED")
    );

    let thrown: unknown = null;
    try {
      await transcribeAudioDetailed("x.webm");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ status: 502 });
    expect((thrown as { message: string }).message).toContain(
      "Could not reach the transcription service"
    );
  });

  it("rejects a response without text", async () => {
    post.mockResolvedValue({ data: { segments: [] } });
    await expect(transcribeAudioDetailed("x.webm")).rejects.toMatchObject({ status: 502 });
  });
});

describe("provider selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to local", async () => {
    vi.resetModules();
    const { getTranscriptionProvider } = await import("../../src/providers/transcription");
    expect(getTranscriptionProvider().name).toBe("local");
  });

  it("selects deepgram when configured with a key", async () => {
    vi.stubEnv("TRANSCRIPTION_PROVIDER", "deepgram");
    vi.stubEnv("DEEPGRAM_API_KEY", "dg-test-not-real");
    vi.stubEnv("DEEPGRAM_MODEL", "nova-3");
    vi.resetModules();
    const { getTranscriptionProvider } = await import("../../src/providers/transcription");
    expect(getTranscriptionProvider().name).toBe("deepgram:nova-3");
  });

  it("refuses to boot with deepgram but no key, or an unknown provider", async () => {
    vi.stubEnv("TRANSCRIPTION_PROVIDER", "deepgram");
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    vi.resetModules();
    await expect(import("../../src/lib/env")).rejects.toThrow(/DEEPGRAM_API_KEY/);

    vi.stubEnv("TRANSCRIPTION_PROVIDER", "whisperx");
    vi.resetModules();
    await expect(import("../../src/lib/env")).rejects.toThrow(/TRANSCRIPTION_PROVIDER/);
  });
});
