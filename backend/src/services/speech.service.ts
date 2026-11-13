import axios from "axios";
import path from "path";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { UpstreamError } from "../types/errors";
import type { RawSegment } from "../types/segment";

const log = logger.child({ module: "speech.service" });

export interface TranscriptionResult {
  text: string;
  segments: RawSegment[];
  /** Length of the transcribed audio, before any offset is applied. */
  durationMs: number;
  language: string | null;
}

/**
 * Whisper occasionally emits filler ("Thank you.", "Bye.") over
 * silence. Segments it is fairly sure contain no speech are dropped so
 * they do not pollute summaries or search results.
 */
const NO_SPEECH_THRESHOLD = 0.75;

/**
 * Validates the segment list returned by the Whisper service. Exported
 * so the filtering rules can be tested without a running service.
 */
export const parseSegments = (value: unknown): RawSegment[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];

    const item = raw as Record<string, unknown>;

    const text = typeof item.text === "string" ? item.text.trim() : "";
    const startMs = Number(item.startMs);
    const endMs = Number(item.endMs);

    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return [];
    }

    const noSpeechProb = Number(item.noSpeechProb);

    if (
      Number.isFinite(noSpeechProb) &&
      noSpeechProb > NO_SPEECH_THRESHOLD
    ) {
      return [];
    }

    return [
      {
        text,
        startMs: Math.max(0, Math.round(startMs)),
        // Guard against an inverted span, which would break duration
        // maths downstream.
        endMs: Math.max(Math.round(startMs), Math.round(endMs)),
      },
    ];
  });
};

/**
 * Sends one audio file to the Whisper service.
 *
 * `offsetMs` shifts every timestamp into the meeting's timeline, which
 * live capture needs because each chunk is transcribed independently
 * and its own timestamps start at zero.
 */
export async function transcribeAudioDetailed(
  audioPath: string,
  offsetMs = 0
): Promise<TranscriptionResult> {
  // Multer stores a path relative to the backend's working
  // directory; the Python service needs an absolute one.
  const absolutePath = path.resolve(audioPath);

  log.debug("Requesting transcription", { absolutePath, offsetMs });

  try {
    const response = await axios.post(
      `${env.aiServiceUrl}/transcribe`,
      {
        file_path: absolutePath,
        offset_ms: offsetMs,
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
      segments: parseSegments(response.data?.segments),
      durationMs: Number.isFinite(reportedDuration)
        ? reportedDuration
        : 0,
      language:
        typeof response.data?.language === "string"
          ? response.data.language
          : null,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      log.error("Transcription request failed", error, {
        aiServiceUrl: env.aiServiceUrl,
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

/**
 * Text-only transcription, kept for callers that do not need segments.
 */
export async function transcribeAudio(
  audioPath: string
): Promise<string> {
  return (await transcribeAudioDetailed(audioPath)).text;
}
