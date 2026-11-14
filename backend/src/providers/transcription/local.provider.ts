import axios from "axios";
import path from "path";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { UpstreamError } from "../../types/errors";
import type { TranscriptionOutput } from "../../types/providers";
import { parseLocalSegments } from "./parse";
import type { AsrProvider, AsrRequest } from "./types";

const log = logger.child({ module: "transcription.local" });

/**
 * Words of the previous chunk sent for boundary de-duplication. The
 * ai-service only looks at the last few; sending more is wasted bytes.
 */
export const PREVIOUS_WORDS_SENT = 12;

/**
 * The ai-service (faster-whisper with VAD, word timestamps, per-channel
 * transcription for stereo and hallucination guards). It reads the file
 * by path, so it must share a filesystem with the backend.
 */
export class LocalTranscriptionProvider implements AsrProvider {
  readonly name = "local";

  constructor(private readonly baseUrl: string = env.aiServiceUrl) {}

  async transcribe(request: AsrRequest): Promise<TranscriptionOutput> {
    // Multer stores a path relative to the backend's working
    // directory; the Python service needs an absolute one.
    const absolutePath = path.resolve(request.filePath);

    log.debug("Requesting transcription", {
      absolutePath,
      offsetMs: request.offsetMs,
      channelLayout: request.channelLayout,
      hints: request.hints?.length ?? 0,
    });

    try {
      const response = await axios.post(
        `${this.baseUrl}/transcribe`,
        {
          file_path: absolutePath,
          offset_ms: request.offsetMs,
          channel_layout: request.channelLayout,
          hints: request.hints ?? [],
          language: request.language ?? null,
          previous_words: (request.previousWords ?? [])
            .slice(-PREVIOUS_WORDS_SENT)
            .map((w) => ({
              w: w.word,
              startMs: w.startMs,
              endMs: w.endMs,
              ...(w.channel ? { channel: w.channel } : {}),
            })),
        },
        {
          // Whisper runs on CPU and can take several minutes on a long
          // recording, so allow far more than the axios default.
          timeout: env.transcriptionTimeoutMs,
        }
      );

      const text = response.data?.text;

      if (typeof text !== "string") {
        throw UpstreamError(
          "Transcription service returned an unexpected response."
        );
      }

      const reportedDuration = Number(response.data?.durationMs);

      return {
        text: text.trim(),
        segments: parseLocalSegments(response.data?.segments),
        durationMs: Number.isFinite(reportedDuration) ? reportedDuration : 0,
        language:
          typeof response.data?.language === "string"
            ? response.data.language
            : null,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        log.error("Transcription request failed", error, {
          aiServiceUrl: this.baseUrl,
          code: error.code,
        });

        if (error.code === "ECONNREFUSED") {
          throw UpstreamError(
            "Could not reach the transcription service. Please make " +
              "sure it is running and try again."
          );
        }

        if (error.code === "ECONNABORTED") {
          throw UpstreamError(
            "Transcription timed out. The recording may be too long."
          );
        }

        const detail =
          typeof error.response?.data?.detail === "string"
            ? error.response.data.detail
            : error.message;

        throw UpstreamError(`Transcription failed: ${detail}`);
      }

      throw error;
    }
  }
}
