import type {
  TranscriptionProvider,
  TranscriptionRequest,
  WordTiming,
} from "../../types/providers";

/** A word from the previous chunk, for boundary de-duplication. */
export interface BoundaryWord extends WordTiming {
  channel?: "mic" | "remote" | null;
}

/**
 * TranscriptionRequest plus what only some providers use. Kept here
 * rather than in types/providers.ts (shared contract) because it is an
 * optimisation of the local provider, not part of the contract.
 */
export interface AsrRequest extends TranscriptionRequest {
  /**
   * Tail words of the chunk before this one on the timeline. The local
   * provider drops words repeated across the cut; others ignore it.
   */
  previousWords?: BoundaryWord[];
}

export interface AsrProvider extends TranscriptionProvider {
  transcribe(
    request: AsrRequest
  ): ReturnType<TranscriptionProvider["transcribe"]>;
}

export const PROVIDER_NAMES = ["local", "deepgram"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
