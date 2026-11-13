import { useContext } from "react";
import { AudioPlayerContext, type AudioPlayerApi } from "./audioPlayerContext";

/** seekTo(ms), jumpToSegment(idx) and friends; see audioPlayerContext.ts. */
export const useAudioPlayer = (): AudioPlayerApi =>
  useContext(AudioPlayerContext);
