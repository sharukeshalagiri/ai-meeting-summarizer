import { useEffect, useRef, useState } from "react";
import { useAudioPlayer } from "./useAudioPlayer";

interface Props {
  src: string;
}

/**
 * Native <audio> registered with AudioPlayerContext, so seekTo and
 * jumpToSegment can drive it. Hides itself when the source cannot load
 * (e.g. a live meeting has no single stored recording).
 */
export function AudioPlayer({ src }: Props) {
  const { registerAudio } = useAudioPlayer();
  const ref = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (failed) return;

    registerAudio(ref.current);
    return () => registerAudio(null);
  }, [registerAudio, failed, src]);

  if (failed) return null;

  return (
    <audio
      ref={ref}
      className="audio-player"
      controls
      preload="metadata"
      src={src}
      onError={() => setFailed(true)}
    >
      Your browser cannot play this recording.
    </audio>
  );
}
