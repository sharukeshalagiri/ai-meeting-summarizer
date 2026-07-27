import axios from "axios";
import path from "path";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { UpstreamError } from "../types/errors";

const log = logger.child({ module: "speech.service" });

export async function transcribeAudio(
  audioPath: string
): Promise<string> {
  // Multer stores a path relative to the backend's working
  // directory; the Python service needs an absolute one.
  const absolutePath = path.resolve(audioPath);

  log.debug("Requesting transcription", { absolutePath });

  try {
    const response = await axios.post(
      `${env.aiServiceUrl}/transcribe`,
      {
        file_path: absolutePath,
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

    return text.trim();
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
