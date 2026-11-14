import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildDeepgramUrl,
  DeepgramTranscriptionProvider,
  mapDeepgramResponse,
  MAX_KEYWORDS,
} from "../../src/providers/transcription/deepgram.provider";

/**
 * Deepgram is a PAID API (gate e). Every test here uses a mocked fetch;
 * nothing in this suite ever reaches api.deepgram.com.
 */

const stereoResponse = {
  metadata: { duration: 12.5 },
  results: {
    channels: [
      { detected_language: "en", alternatives: [{ transcript: "", words: [] }] },
      { alternatives: [{ transcript: "", words: [] }] },
    ],
    utterances: [
      {
        start: 3.0,
        end: 4.2,
        channel: 0,
        transcript: "I'll send the deck.",
        words: [
          { word: "i'll", punctuated_word: "I'll", start: 3.0, end: 3.3, confidence: 0.98 },
          { word: "send", start: 3.3, end: 3.6, confidence: 0.97 },
          { word: "the", start: 3.6, end: 3.7 },
          { word: "deck", punctuated_word: "deck.", start: 3.7, end: 4.2, confidence: 0.9 },
        ],
      },
      { start: 0.5, end: 2.0, channel: 1, transcript: "Can you send the deck?", words: [] },
      { start: 5, end: 6, channel: 1, transcript: "   " },
      "garbage",
    ],
  },
};

describe("buildDeepgramUrl", () => {
  it("sets multichannel for stereo and keywords for nova-2", () => {
    const url = new URL(
      buildDeepgramUrl(
        { filePath: "x", offsetMs: 0, channelLayout: "stereo-mic-left", hints: ["Priya", "priya", " Kubernetes "] },
        "nova-2"
      )
    );
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("multichannel")).toBe("true");
    expect(url.searchParams.get("diarize")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("detect_language")).toBe("true");
    expect(url.searchParams.getAll("keywords")).toEqual(["Priya", "Kubernetes"]);
    expect(url.searchParams.has("keyterm")).toBe(false);
  });

  it("uses keyterm on nova-3, a fixed language, and caps the hint count", () => {
    const hints = Array.from({ length: MAX_KEYWORDS + 20 }, (_, i) => `term${i}`);
    const url = new URL(
      buildDeepgramUrl({ filePath: "x", offsetMs: 0, channelLayout: "mono", language: "en", hints }, "nova-3")
    );
    expect(url.searchParams.has("multichannel")).toBe(false);
    expect(url.searchParams.get("language")).toBe("en");
    expect(url.searchParams.has("detect_language")).toBe(false);
    expect(url.searchParams.getAll("keyterm")).toHaveLength(MAX_KEYWORDS);
  });
});

describe("mapDeepgramResponse", () => {
  it("maps utterances to segments with channels, words and the offset", () => {
    const out = mapDeepgramResponse(stereoResponse, { offsetMs: 10000, channelLayout: "stereo-mic-left" });

    expect(out.durationMs).toBe(12500);
    expect(out.language).toBe("en");
    expect(out.text).toBe("Can you send the deck? I'll send the deck.");
    expect(out.segments).toEqual([
      { text: "Can you send the deck?", startMs: 10500, endMs: 12000, channel: "remote" },
      {
        text: "I'll send the deck.",
        startMs: 13000,
        endMs: 14200,
        channel: "mic",
        words: [
          { word: "I'll", startMs: 13000, endMs: 13300, probability: 0.98 },
          { word: "send", startMs: 13300, endMs: 13600, probability: 0.97 },
          { word: "the", startMs: 13600, endMs: 13700 },
          { word: "deck.", startMs: 13700, endMs: 14200, probability: 0.9 },
        ],
      },
    ]);
  });

  it("leaves channel unset for mono and falls back to channel alternatives", () => {
    const out = mapDeepgramResponse(
      {
        metadata: { duration: 2 },
        results: {
          channels: [
            { alternatives: [{ transcript: "hello world", words: [
              { word: "hello", start: 0.1, end: 0.5 },
              { word: "world", start: 0.6, end: 1.0 },
            ] }] },
          ],
        },
      },
      { offsetMs: 0, channelLayout: "mono" }
    );
    expect(out.segments).toEqual([
      {
        text: "hello world",
        startMs: 100,
        endMs: 1000,
        words: [
          { word: "hello", startMs: 100, endMs: 500 },
          { word: "world", startMs: 600, endMs: 1000 },
        ],
      },
    ]);
    expect(out.language).toBeNull();
  });

  it("survives a malformed body", () => {
    expect(mapDeepgramResponse(null, { offsetMs: 0, channelLayout: "mono" })).toEqual({
      text: "",
      segments: [],
      durationMs: 0,
      language: null,
    });
  });
});

describe("DeepgramTranscriptionProvider (mocked fetch only)", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "w1-asr-dg-"));
    file = path.join(dir, "chunk.bin");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("posts the audio with the token header and maps the reply", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(stereoResponse), { status: 200 }));
    const provider = new DeepgramTranscriptionProvider("dg-test-not-real", "nova-2", fetchMock as unknown as typeof fetch);

    const out = await provider.transcribe({
      filePath: file,
      offsetMs: 0,
      channelLayout: "stereo-mic-left",
      hints: ["Priya"],
    });

    expect(provider.name).toBe("deepgram:nova-2");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("multichannel=true");
    expect(url).toContain("keywords=Priya");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Token dg-test-not-real");
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(out.segments.map((s) => s.channel)).toEqual(["remote", "mic"]);
  });

  it("maps an error status to a 502 without the body", async () => {
    const fetchMock = vi.fn(async () => new Response("secret detail", { status: 401 }));
    const provider = new DeepgramTranscriptionProvider("k", "nova-2", fetchMock as unknown as typeof fetch);

    const error = (await provider
      .transcribe({ filePath: file, offsetMs: 0, channelLayout: "mono" })
      .catch((e: unknown) => e)) as { status: number; message: string };

    expect(error.status).toBe(502);
    expect(error.message).not.toContain("secret");
  });

  it("maps a network failure to a 502", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = new DeepgramTranscriptionProvider("k", "nova-2", fetchMock as unknown as typeof fetch);
    await expect(
      provider.transcribe({ filePath: file, offsetMs: 0, channelLayout: "mono" })
    ).rejects.toMatchObject({ status: 502 });
  });

  it("never calls out without a key", async () => {
    const fetchMock = vi.fn();
    const provider = new DeepgramTranscriptionProvider(null, "nova-2", fetchMock as unknown as typeof fetch);
    await expect(
      provider.transcribe({ filePath: file, offsetMs: 0, channelLayout: "mono" })
    ).rejects.toThrow(/DEEPGRAM_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
