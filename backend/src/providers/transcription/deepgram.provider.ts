import fs from "fs/promises";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { AppError, UpstreamError } from "../../types/errors";
import type {
  TranscribedSegment,
  TranscriptionOutput,
  WordTiming,
} from "../../types/providers";
import type { AsrProvider, AsrRequest } from "./types";

const log = logger.child({ module: "transcription.deepgram" });

export const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
/** Deepgram rejects requests with more keywords than this. */
export const MAX_KEYWORDS = 100;

type FetchLike = typeof fetch;

/**
 * Builds the /v1/listen query. Exported for tests.
 *
 * - multichannel for stereo-mic-left: Deepgram transcribes each channel
 *   separately, so channel 0 (left) is the mic and 1 (right) is remote,
 *   matching the local provider.
 * - diarize + utterances: speaker turns within each channel, returned as
 *   ready-made segments.
 * - smart_format: punctuation, numbers and dates formatted.
 * - Hints: nova-3 models take `keyterm`, older ones `keywords`.
 */
export const buildDeepgramUrl = (request: AsrRequest, model: string): string => {
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    diarize: "true",
    utterances: "true",
    punctuate: "true",
  });

  if (request.channelLayout === "stereo-mic-left") {
    params.set("multichannel", "true");
  }

  if (request.language) {
    params.set("language", request.language);
  } else {
    params.set("detect_language", "true");
  }

  const hintParam = model.startsWith("nova-3") ? "keyterm" : "keywords";
  const seen = new Set<string>();

  for (const raw of request.hints ?? []) {
    const term = raw.trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    if (seen.size >= MAX_KEYWORDS) break;
    seen.add(term.toLowerCase());
    params.append(hintParam, term);
  }

  return `${DEEPGRAM_URL}?${params.toString()}`;
};

const num = (value: unknown): number | null => {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : null;
};

const toMs = (seconds: number, offsetMs: number) =>
  Math.max(0, Math.round(seconds * 1000)) + offsetMs;

const parseDeepgramWords = (value: unknown, offsetMs: number): WordTiming[] =>
  Array.isArray(value)
    ? value.flatMap((raw) => {
        if (typeof raw !== "object" || raw === null) return [];
        const item = raw as Record<string, unknown>;
        const word =
          typeof item.punctuated_word === "string"
            ? item.punctuated_word
            : typeof item.word === "string"
              ? item.word
              : "";
        const start = num(item.start);
        const end = num(item.end);
        if (!word.trim() || start === null || end === null) return [];
        const confidence = num(item.confidence);
        return [
          {
            word: word.trim(),
            startMs: toMs(start, offsetMs),
            endMs: Math.max(toMs(start, offsetMs), toMs(end, offsetMs)),
            ...(confidence !== null ? { probability: confidence } : {}),
          },
        ];
      })
    : [];

/**
 * Maps a Deepgram /v1/listen response to the provider contract. Never
 * trusts the shape. Exported for tests.
 */
export const mapDeepgramResponse = (
  body: unknown,
  request: Pick<AsrRequest, "offsetMs" | "channelLayout" | "language">
): TranscriptionOutput => {
  const root = (typeof body === "object" && body !== null ? body : {}) as {
    metadata?: { duration?: unknown };
    results?: {
      utterances?: unknown;
      channels?: {
        detected_language?: unknown;
        alternatives?: { transcript?: unknown; words?: unknown }[];
      }[];
    };
  };

  const stereo = request.channelLayout === "stereo-mic-left";
  const channelFor = (index: unknown) =>
    stereo ? (Number(index) === 0 ? "mic" : "remote") : null;
  const offsetMs = request.offsetMs;

  let segments: TranscribedSegment[] = [];

  if (Array.isArray(root.results?.utterances)) {
    segments = root.results.utterances.flatMap((raw: unknown) => {
      if (typeof raw !== "object" || raw === null) return [];
      const u = raw as Record<string, unknown>;
      const text = typeof u.transcript === "string" ? u.transcript.trim() : "";
      const start = num(u.start);
      const end = num(u.end);
      if (!text || start === null || end === null) return [];
      const words = parseDeepgramWords(u.words, offsetMs);
      const channel = channelFor(u.channel);
      return [
        {
          text,
          startMs: toMs(start, offsetMs),
          endMs: Math.max(toMs(start, offsetMs), toMs(end, offsetMs)),
          ...(channel ? { channel } : {}),
          ...(words.length ? { words } : {}),
        },
      ];
    });
  } else {
    // No utterances (older responses): one segment per channel.
    segments = (root.results?.channels ?? []).flatMap((ch, index) => {
      const alt = ch?.alternatives?.[0];
      const text = typeof alt?.transcript === "string" ? alt.transcript.trim() : "";
      const words = parseDeepgramWords(alt?.words, offsetMs);
      if (!text || !words.length) return [];
      const channel = channelFor(index);
      return [
        {
          text,
          startMs: words[0].startMs,
          endMs: words[words.length - 1].endMs,
          ...(channel ? { channel } : {}),
          words,
        },
      ];
    });
  }

  segments.sort((a, b) => a.startMs - b.startMs);

  const duration = num(root.metadata?.duration);
  const detected = root.results?.channels?.find(
    (ch) => typeof ch?.detected_language === "string"
  )?.detected_language;

  return {
    text: segments.map((s) => s.text).join(" "),
    segments,
    durationMs: duration !== null ? Math.round(duration * 1000) : 0,
    language:
      request.language ?? (typeof detected === "string" ? detected : null),
  };
};

/**
 * Deepgram's hosted API. PAID per audio minute: it is only used when
 * TRANSCRIPTION_PROVIDER=deepgram and DEEPGRAM_API_KEY are both set
 * (env.ts refuses to boot otherwise). Plain fetch, no SDK, so the
 * request is easy to read and to mock.
 */
export class DeepgramTranscriptionProvider implements AsrProvider {
  readonly name: string;

  constructor(
    private readonly apiKey: string | null = env.deepgramApiKey,
    private readonly model: string = env.deepgramModel,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.name = `deepgram:${model}`;
  }

  async transcribe(request: AsrRequest): Promise<TranscriptionOutput> {
    if (!this.apiKey) {
      throw new AppError(
        "Deepgram is selected but DEEPGRAM_API_KEY is not set.",
        500
      );
    }

    const audio = await fs.readFile(request.filePath);
    const url = buildDeepgramUrl(request, this.model);

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: audio,
        signal: AbortSignal.timeout(env.transcriptionTimeoutMs),
      });
    } catch (error) {
      log.error("Deepgram request failed", error);
      throw UpstreamError("Could not reach the transcription service.");
    }

    if (!response.ok) {
      // The body may echo request details; log the status only.
      log.error("Deepgram returned an error", undefined, {
        status: response.status,
      });
      throw UpstreamError(
        `Transcription failed (provider status ${response.status}).`
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw UpstreamError(
        "Transcription service returned an unexpected response."
      );
    }

    return mapDeepgramResponse(body, request);
  }
}
