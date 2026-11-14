import { env } from "../../lib/env";
import { DeepgramTranscriptionProvider } from "./deepgram.provider";
import { LocalTranscriptionProvider } from "./local.provider";
import type { AsrProvider, ProviderName } from "./types";

export type { AsrProvider, AsrRequest, BoundaryWord, ProviderName } from "./types";
export { PROVIDER_NAMES } from "./types";

/** Builds a provider by name. Exported so tests can pick one directly. */
export const createTranscriptionProvider = (
  name: ProviderName
): AsrProvider =>
  name === "deepgram"
    ? new DeepgramTranscriptionProvider()
    : new LocalTranscriptionProvider();

let current: AsrProvider | null = null;

/**
 * The provider chosen by TRANSCRIPTION_PROVIDER (validated in env.ts),
 * created once. Services depend on this, never on a concrete client.
 */
export const getTranscriptionProvider = (): AsrProvider => {
  if (!current) current = createTranscriptionProvider(env.transcriptionProvider);
  return current;
};
