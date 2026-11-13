/**
 * Provider interfaces for swappable speech back ends.
 *
 * Types only: no implementation is wired yet. Wave 1 (w1-asr) implements
 * TranscriptionProvider, Wave 2 (w2-spk) implements DiarizationProvider.
 * Services should depend on these interfaces, not on a concrete client,
 * so Whisper, faster-whisper, a hosted API, or pyannote can be swapped
 * without touching callers.
 */

import type { ChannelLayout, MeetingMode } from "./capture";

/** One word with timing, when the provider supplies word-level output. */
export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
  /** Provider confidence 0..1, if available. */
  probability?: number;
}

export interface TranscribedSegment {
  text: string;
  /** Milliseconds on the meeting timeline (offset already applied). */
  startMs: number;
  endMs: number;
  /** Set when the audio was stereo and channels were split. */
  channel?: "mic" | "remote" | null;
  words?: WordTiming[];
  /**
   * e.g. Whisper's no_speech_prob; higher = less likely speech. Used by
   * the hallucination guards, which drop non-speech instead of labelling
   * it (TranscriptSegment.noiseLabel is the later CLEAN-pass relevance
   * label, not an ASR output).
   */
  noSpeechProb?: number;
}

export interface TranscriptionRequest {
  /** Absolute path to the audio file. */
  filePath: string;
  /** Added to every timestamp to place it on the meeting timeline. */
  offsetMs: number;
  channelLayout: ChannelLayout;
  /** ISO 639-1 code if known; providers may auto-detect when absent. */
  language?: string | null;
  /** Vocabulary / context hints (names, jargon) to bias recognition. */
  hints?: string[];
  mode?: MeetingMode;
}

export interface TranscriptionOutput {
  text: string;
  segments: TranscribedSegment[];
  /** Length of the audio itself, before the offset. */
  durationMs: number;
  language: string | null;
}

export interface TranscriptionProvider {
  /** Stable identifier recorded for evaluation, e.g. "whisper-base". */
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionOutput>;
}

export interface DiarizationRequest {
  meetingId: string;
  segments: TranscribedSegment[];
  /** Audio, for acoustic diarization; text-only providers ignore it. */
  filePath?: string | null;
  channelLayout: ChannelLayout;
  /** Participant names from LiveSession.roster, used as name hints. */
  roster?: string[];
}

export interface DiarizedOutputSegment extends TranscribedSegment {
  /** Display label, e.g. "Priya" or "Speaker 2". */
  speaker: string;
  /** Stable per-meeting label matching SpeakerProfile.label. */
  speakerLabel: string;
}

export interface DiarizationOutput {
  /** Same length and order as the request's segments. */
  segments: DiarizedOutputSegment[];
  speakers: {
    label: string;
    displayName: string | null;
    /** Voice embedding when acoustic; empty for text-based providers. */
    centroid: number[];
  }[];
}

export interface DiarizationProvider {
  readonly name: string;
  diarize(request: DiarizationRequest): Promise<DiarizationOutput>;
}
