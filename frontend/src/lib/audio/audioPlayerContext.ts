import { createContext } from "react";

/**
 * UI contract: any component under <AudioPlayerProvider> can play the
 * meeting from a moment, or jump to a transcript segment.
 *
 * Segment references are always TranscriptSegment.idx values, never
 * array positions: live meetings have sparse idx (seq * 1000 + i).
 */
export interface AudioPlayerApi {
  /** Seeks the registered <audio> to `ms` and plays. No-op without one. */
  seekTo: (ms: number) => void;
  /**
   * Scrolls to and highlights segment `idx` (element id="seg-<idx>")
   * and plays from its start.
   */
  jumpToSegment: (idx: number) => void;
  /** Called by <AudioPlayer>; pass null on unmount. */
  registerAudio: (element: HTMLAudioElement | null) => void;
  /** True when an <audio> with a playable source is registered. */
  hasAudio: boolean;
}

const noop = () => {};

export const AudioPlayerContext = createContext<AudioPlayerApi>({
  seekTo: noop,
  jumpToSegment: noop,
  registerAudio: noop,
  hasAudio: false,
});
