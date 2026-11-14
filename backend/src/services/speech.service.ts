import { logger } from "../lib/logger";
import {
  getTranscriptionProvider,
  type AsrRequest,
  type BoundaryWord,
} from "../providers/transcription";
import { parseLocalSegments } from "../providers/transcription/parse";
import type { ChannelLayout, MeetingMode } from "../types/capture";
import type { TranscribedSegment } from "../types/providers";
import type { RawSegment } from "../types/segment";

const log = logger.child({ module: "speech.service" });

/** One word as stored in TranscriptSegment.words (docs/SCHEMA_NOTES.md). */
export interface StoredWord {
  w: string;
  startMs: number;
  endMs: number;
  p?: number;
}

/**
 * A segment ready to store. `channel` and `words` are only present when
 * the provider supplied them, so callers that only know RawSegment keep
 * working unchanged.
 */
export interface AsrSegment extends RawSegment {
  /** "mic" (left, the user) | "remote" (right, everyone else). */
  channel?: "mic" | "remote";
  words?: StoredWord[];
}

export interface TranscriptionResult {
  text: string;
  segments: AsrSegment[];
  /** Length of the transcribed audio, before any offset is applied. */
  durationMs: number;
  language: string | null;
  /** Provider that produced it, e.g. "local" or "deepgram:nova-2". */
  provider?: string;
}

export interface TranscribeOptions {
  /** Capture contract layout; stereo-mic-left is split per channel. */
  channelLayout?: ChannelLayout;
  /** LiveSession.hints: names, jargon, agenda. */
  hints?: string[];
  /** LiveSession.roster: participant names, placed before hints. */
  roster?: string[];
  language?: string | null;
  mode?: MeetingMode;
  /**
   * Tail words of the previous chunk (its segments' `words`, each with
   * the segment's channel), to drop words repeated across the cut.
   */
  previousWords?: (StoredWord & { channel?: string | null })[];
}

/** Provider segment -> storable segment (word shape of SCHEMA_NOTES). */
export const toStoredSegment = (segment: TranscribedSegment): AsrSegment => ({
  text: segment.text,
  startMs: segment.startMs,
  endMs: segment.endMs,
  ...(segment.channel ? { channel: segment.channel } : {}),
  ...(segment.words?.length
    ? {
        words: segment.words.map((word) => ({
          w: word.word,
          startMs: word.startMs,
          endMs: word.endMs,
          ...(word.probability !== undefined ? { p: word.probability } : {}),
        })),
      }
    : {}),
});

/**
 * Validates the segment list returned by the ai-service (dropping
 * likely hallucinations) and keeps text, timing, channel and words.
 * Exported so the filtering rules can be tested without a running
 * service.
 */
export const parseSegments = (value: unknown): AsrSegment[] =>
  parseLocalSegments(value).map(toStoredSegment);

/**
 * Roster names first: they are the hints most likely to be misspelt and
 * the ones the prompt cap should keep.
 */
export const combineHints = (roster?: string[], hints?: string[]): string[] => {
  const seen = new Set<string>();
  return [...(roster ?? []), ...(hints ?? [])].flatMap((raw) => {
    const term = typeof raw === "string" ? raw.trim() : "";
    const key = term.toLowerCase();
    if (!term || seen.has(key)) return [];
    seen.add(key);
    return [term];
  });
};

const toBoundaryWords = (
  words: TranscribeOptions["previousWords"]
): BoundaryWord[] =>
  (words ?? []).map((word) => ({
    word: word.w,
    startMs: word.startMs,
    endMs: word.endMs,
    channel:
      word.channel === "mic" || word.channel === "remote" ? word.channel : null,
  }));

/**
 * Transcribes one audio file with the configured provider
 * (TRANSCRIPTION_PROVIDER).
 *
 * `offsetMs` shifts every timestamp into the meeting's timeline, which
 * live capture needs because each chunk is transcribed independently
 * and its own timestamps start at zero. `options` is optional so
 * existing callers (and test fakes) keep their two-argument form.
 */
export async function transcribeAudioDetailed(
  audioPath: string,
  offsetMs = 0,
  options: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  const provider = getTranscriptionProvider();

  const request: AsrRequest = {
    filePath: audioPath,
    offsetMs,
    channelLayout: options.channelLayout ?? "mono",
    language: options.language ?? null,
    hints: combineHints(options.roster, options.hints),
    ...(options.mode ? { mode: options.mode } : {}),
    previousWords: toBoundaryWords(options.previousWords),
  };

  const output = await provider.transcribe(request);

  log.debug("Transcribed", {
    provider: provider.name,
    segments: output.segments.length,
    channelLayout: request.channelLayout,
  });

  return {
    text: output.text,
    segments: output.segments.map(toStoredSegment),
    durationMs: output.durationMs,
    language: output.language,
    provider: provider.name,
  };
}

/**
 * Text-only transcription, kept for callers that do not need segments.
 */
export async function transcribeAudio(
  audioPath: string
): Promise<string> {
  return (await transcribeAudioDetailed(audioPath)).text;
}
