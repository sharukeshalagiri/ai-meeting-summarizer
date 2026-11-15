import type { Readable } from "stream";
import { env } from "../env";
import { assertKey } from "./keys";
import { LocalStorage } from "./local";

export { assertKey };

/**
 * Where recordings and job artifacts live.
 *
 * Keys are relative POSIX paths ("recordings/<meetingId>/live.ogg").
 * Local disk is the only driver today; an S3-compatible one can be added
 * behind this interface. `localPath` exists because the ai-service and
 * ffmpeg read files by path: an object-store driver would download to a
 * temp file there.
 */
export interface Storage {
  readonly driver: string;
  /** Absolute path of a key on this machine. */
  localPath(key: string): string;
  /** Path of a key relative to the backend's working directory (Meeting.audioPath). */
  relativePath(key: string): string;
  put(key: string, data: Buffer | string): Promise<void>;
  putStream(key: string, stream: Readable): Promise<void>;
  /** Null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

/** Keys used by the job pipeline, in one place. */
export const storageKeys = {
  /** ASR output handed from the transcribe job to the diarize job. */
  asr: (meetingId: string) => `artifacts/${meetingId}/asr.json`,
  /** A live meeting's assembled stereo recording. */
  liveRecording: (meetingId: string) => `recordings/${meetingId}/live.ogg`,
  /** Which chunks the assembled recording was built from. */
  liveManifest: (meetingId: string) => `recordings/${meetingId}/manifest.json`,
};

let instance: Storage | null = null;

export const getStorage = (): Storage => {
  if (!instance) instance = new LocalStorage(env.storageDir);
  return instance;
};

/** Tests swap the storage root. */
export const setStorage = (storage: Storage | null): void => {
  instance = storage;
};
