import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioPlayerContext, type AudioPlayerApi } from "./audioPlayerContext";
import { scrollToSegment } from "./jumpToSegment";

interface Props {
  children: ReactNode;
  /**
   * idx -> startMs for the meeting's segments, so a jump can seek even
   * when the transcript is not rendered (e.g. from the summary tab).
   */
  segmentStarts?: ReadonlyMap<number, number>;
  /**
   * Called before scrolling, e.g. to switch to the transcript tab. The
   * scroll is retried for a few frames while the segment mounts.
   */
  onJump?: (idx: number) => void;
}

const SCROLL_ATTEMPTS = 10;

export function AudioPlayerProvider({ children, segmentStarts, onJump }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [hasAudio, setHasAudio] = useState(false);

  const registerAudio = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element;
    setHasAudio(element !== null);
  }, []);

  const seekTo = useCallback((ms: number) => {
    const audio = audioRef.current;

    if (!audio || !Number.isFinite(ms)) return;

    audio.currentTime = Math.max(0, ms) / 1000;
    // play() rejects when the browser blocks autoplay or the source
    // failed; seeking still happened, so there is nothing to surface.
    void audio.play().catch(() => {});
  }, []);

  const jumpToSegment = useCallback(
    (idx: number) => {
      onJump?.(idx);

      const known = segmentStarts?.get(idx);
      if (known != null) seekTo(known);

      let attempts = 0;
      const tryScroll = () => {
        const start = scrollToSegment(idx);

        if (start != null) {
          if (known == null) seekTo(start);
          return;
        }

        if (++attempts < SCROLL_ATTEMPTS) {
          window.requestAnimationFrame(tryScroll);
        }
      };

      tryScroll();
    },
    [onJump, segmentStarts, seekTo]
  );

  const value = useMemo<AudioPlayerApi>(
    () => ({ seekTo, jumpToSegment, registerAudio, hasAudio }),
    [seekTo, jumpToSegment, registerAudio, hasAudio]
  );

  return (
    <AudioPlayerContext.Provider value={value}>
      {children}
    </AudioPlayerContext.Provider>
  );
}
