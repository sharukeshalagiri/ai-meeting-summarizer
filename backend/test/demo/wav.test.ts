import { describe, expect, it } from "vitest";
import { assembleStereo, parseWav, toneClip, writeWav } from "../../src/demo/audio/wav";
import { pickEngine, speakLines } from "../../src/demo/audio/tts";

describe("demo audio", () => {
  it("round-trips a mono WAV", () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const clip = parseWav(writeWav(samples, 16000, 1));
    expect(clip.sampleRate).toBe(16000);
    expect([...clip.samples]).toEqual([...samples]);
  });

  it("downmixes a stereo WAV to mono", () => {
    const clip = parseWav(writeWav(Int16Array.from([100, 300, -200, 0]), 8000, 2));
    expect([...clip.samples]).toEqual([200, -100]);
  });

  it("rejects what is not a WAV", () => {
    expect(() => parseWav(Buffer.from("not audio at all, really"))).toThrow(/WAV/);
  });

  it("makes tone clips of the asked length", () => {
    const clip = toneClip(1500, 2);
    expect(clip.samples.length).toBe(24000);
    expect(Math.max(...clip.samples)).toBeGreaterThan(1000);
  });

  it("lays lines out in stereo: mic on the left, others on the right", () => {
    const a = toneClip(1000, 0);
    const b = toneClip(500, 1);
    const { wav, timings } = assembleStereo(
      [
        { clip: a, mic: true },
        { clip: b, mic: false },
      ],
      250
    );

    expect(timings).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 1250, endMs: 1750 },
    ]);
    expect(wav.readUInt16LE(22)).toBe(2);

    const frame = (i: number) => [wav.readInt16LE(44 + i * 4), wav.readInt16LE(44 + i * 4 + 2)];
    // Inside line one only the left channel moves; inside line two only the right.
    const left = Array.from({ length: 16000 }, (_, i) => frame(i));
    expect(left.some(([l]) => l !== 0)).toBe(true);
    expect(left.every(([, r]) => r === 0)).toBe(true);
    const right = Array.from({ length: 8000 }, (_, i) => frame(20000 + i));
    expect(right.every(([l]) => l === 0)).toBe(true);
    expect(right.some(([, r]) => r !== 0)).toBe(true);
  });

  it("falls back to tones without any engine", async () => {
    expect(await pickEngine("tones")).toBe("tones");
    const clips = await speakLines("tones", [{ text: "hi", speaker: 0, fallbackMs: 2000 }]);
    expect(clips[0].samples.length).toBe(32000);
  });
});
