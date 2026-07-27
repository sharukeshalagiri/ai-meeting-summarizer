import axios from "axios";
import path from "path";
import { UpstreamError } from "../types/errors";

const AI_SERVICE_URL =
  process.env.AI_SERVICE_URL || "http://localhost:8000";

// Whisper runs on CPU and can take several minutes on a long
// recording, so allow far more than the axios default.
const TRANSCRIBE_TIMEOUT_MS = 15 * 60 * 1000;

export async function transcribeAudio(
  audioPath: string
): Promise<string> {
  // Multer stores a path relative to the backend's working
  // directory; the Python service needs an absolute one.
  const absolutePath = path.resolve(audioPath);

  console.log("Transcribing:", absolutePath);

  try {
    const response = await axios.post(
      `${AI_SERVICE_URL}/transcribe`,
      {
        file_path: absolutePath,
      },
      {
        timeout: TRANSCRIBE_TIMEOUT_MS,
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
