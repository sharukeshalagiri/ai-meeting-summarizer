import { estimateTimings, LINE_GAP_MS, speakersOf } from "../build";
import type { DemoMeetingSpec, SegmentTiming } from "../types";
import { encodeForPlayback, speakLines, type TtsEngine } from "./tts";
import { assembleStereo } from "./wav";

export interface DemoRecording {
  data: Buffer;
  ext: "ogg" | "wav";
  /** One per transcript line: where it is in this recording. */
  timings: SegmentTiming[];
  engine: TtsEngine;
}

/**
 * Speaks every line of a demo meeting and lays the clips out as one
 * stereo recording (left = the user's mic, right = everyone else, as in
 * the capture contract). The returned timings replace the estimated
 * ones, so every chip and transcript line seeks to where it is spoken.
 */
export const generateRecording = async (
  spec: DemoMeetingSpec,
  engine: TtsEngine,
  ffmpeg?: string
): Promise<DemoRecording> => {
  const speakerIndex = new Map(speakersOf(spec).map((s, i) => [s.displayName, i]));
  const estimated = estimateTimings(spec.lines);

  const clips = await speakLines(
    engine,
    spec.lines.map(([speaker, text], i) => ({
      text,
      speaker: speakerIndex.get(speaker) ?? 0,
      fallbackMs: estimated[i].endMs - estimated[i].startMs,
    }))
  );

  const { wav, timings } = assembleStereo(
    clips.map((clip, i) => ({ clip, mic: spec.lines[i][0] === spec.me })),
    LINE_GAP_MS
  );
  const encoded = await encodeForPlayback(wav, ffmpeg);

  return { ...encoded, timings, engine };
};
