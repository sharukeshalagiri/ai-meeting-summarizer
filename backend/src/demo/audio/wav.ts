import type { SegmentTiming } from "../types";

/**
 * Minimal 16-bit PCM WAV helpers for the demo audio. No dependencies:
 * the demo recording is assembled from one clip per transcript line, in
 * the capture contract's stereo layout (left = the user's mic, right =
 * everyone else), so playback sounds like a real capture.
 */

export interface PcmClip {
  sampleRate: number;
  /** Mono samples. */
  samples: Int16Array;
}

/** Reads a mono or stereo 16-bit PCM WAV; stereo is downmixed to mono. */
export const parseWav = (buffer: Buffer): PcmClip => {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      const format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
      if (format !== 1 && format !== 0xfffe) throw new Error(`Unsupported WAV format ${format}`);
    } else if (id === "data") {
      if (bits !== 16 || channels < 1) throw new Error("Only 16-bit PCM WAV is supported");
      // Some writers leave the size at 0 or past the end while streaming.
      const end = Math.min(buffer.length, size > 0 ? body + size : buffer.length);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buffer.readInt16LE(body + (i * channels + c) * 2);
        samples[i] = Math.round(sum / channels);
      }
      return { sampleRate, samples };
    }

    offset = body + size + (size % 2);
  }

  throw new Error("WAV has no data chunk");
};

/** A 16-bit PCM WAV file from interleaved samples. */
export const writeWav = (interleaved: Int16Array, sampleRate: number, channels: number): Buffer => {
  const dataBytes = interleaved.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < interleaved.length; i++) out.writeInt16LE(interleaved[i], 44 + i * 2);
  return out;
};

/** Pitches for the tone fallback, one per speaker (Hz). */
const PITCHES = [196, 147, 262, 175, 233, 131];

/**
 * The fallback when no text-to-speech engine is installed: a soft,
 * syllable-paced hum at a pitch per speaker, as long as the line would
 * take to say. Playable and deterministic, clearly not speech.
 */
export const toneClip = (durationMs: number, speakerIndex: number, sampleRate = 16000): PcmClip => {
  const count = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Int16Array(count);
  const pitch = PITCHES[speakerIndex % PITCHES.length];
  const syllablesPerSecond = 4;

  for (let i = 0; i < count; i++) {
    const t = i / sampleRate;
    const envelope = Math.sin(Math.PI * ((t * syllablesPerSecond) % 1)) ** 2;
    // Fade the clip in and out so lines never click.
    const edge = Math.min(1, t / 0.02, (count - i) / sampleRate / 0.02);
    const wave = Math.sin(2 * Math.PI * pitch * t) + 0.3 * Math.sin(4 * Math.PI * pitch * t);
    samples[i] = Math.round(0.18 * 32767 * envelope * edge * (wave / 1.3));
  }

  return { sampleRate, samples };
};

export interface StereoLine {
  clip: PcmClip;
  /** true: the user's line (left channel); false: everyone else (right). */
  mic: boolean;
}

/**
 * Lays the lines end to end with a gap between them, mic lines on the
 * left channel and the rest on the right, and returns the stereo WAV
 * with each line's real start and end, which become the segment times.
 */
export const assembleStereo = (lines: StereoLine[], gapMs: number): { wav: Buffer; timings: SegmentTiming[] } => {
  if (!lines.length) throw new Error("No lines to assemble");
  const sampleRate = lines[0].clip.sampleRate;
  if (lines.some((line) => line.clip.sampleRate !== sampleRate)) {
    throw new Error("Every clip must share one sample rate");
  }

  const gap = Math.round((gapMs / 1000) * sampleRate);
  const frames = lines.reduce((n, line) => n + line.clip.samples.length, 0) + gap * (lines.length - 1);
  const interleaved = new Int16Array(frames * 2);
  const timings: SegmentTiming[] = [];

  let cursor = 0;
  for (const line of lines) {
    const channel = line.mic ? 0 : 1;
    const { samples } = line.clip;
    for (let i = 0; i < samples.length; i++) interleaved[(cursor + i) * 2 + channel] = samples[i];

    const startMs = Math.round((cursor / sampleRate) * 1000);
    cursor += samples.length;
    timings.push({ startMs, endMs: Math.round((cursor / sampleRate) * 1000) });
    cursor += gap;
  }

  return { wav: writeWav(interleaved, sampleRate, 2), timings };
};
