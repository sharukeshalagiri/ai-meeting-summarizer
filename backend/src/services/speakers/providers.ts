import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { env } from "../../lib/env";
import type {
  DiarizationOutput,
  DiarizationProvider,
  DiarizationRequest,
  DiarizedOutputSegment,
} from "../../types/providers";
import { labelWithGemini, type LabelledLine } from "./textLabels";

/**
 * Diarization providers behind DiarizationProvider (types/providers.ts),
 * chosen by DIARIZATION_PROVIDER:
 *
 * - `voice` (default): the ai-service's POST /diarize (sherpa-onnx
 *   speaker embeddings, CPU, no torch). Returns per-chunk clusters with
 *   centroids, which the matcher keeps stable across chunks.
 * - `text`: Gemini infers turns from the conversation. Also the fallback
 *   whenever voice diarization is unavailable.
 * - `deepgram`: Deepgram's diarize=true on the chunk. PAID per audio
 *   minute (engineer's gate e). Its speaker numbers restart with every
 *   request and it returns no embeddings, so across chunks it is only as
 *   stable as its own numbering.
 *
 * Each provider labels one request's segments with request-local labels
 * (`speakerLabel`); the meeting-level SpeakerProfile is chosen later.
 */

/** A chunk-level request: adds where the file sits on the timeline. */
export interface ChunkDiarizationRequest extends DiarizationRequest {
  /** Meeting-timeline position of the file's first sample. */
  offsetMs: number;
  /** Already-labelled lines before this chunk (text provider). */
  context?: LabelledLine[];
  /** Labels the meeting already uses (text provider). */
  knownLabels?: string[];
}

export class DiarizationUnavailable extends Error {}

/** Request-local label for segments too short to embed. */
export const UNATTRIBUTED = "";

type Poster = (
  url: string,
  body: unknown,
  config: { timeout: number }
) => Promise<{ data: unknown }>;

const asNumberArray = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((x) => typeof x === "number" && Number.isFinite(x))
    ? (value as number[])
    : null;

/**
 * Validates the ai-service response; never trusts its shape. Exported
 * for tests.
 */
export const parseVoiceClusters = (
  body: unknown,
  segmentCount: number
): { members: number[]; centroid: number[] }[] => {
  const clusters = (body as { clusters?: unknown } | null)?.clusters;
  if (!Array.isArray(clusters)) {
    throw new Error("Diarization service returned an unexpected response.");
  }

  const seen = new Set<number>();

  return clusters.flatMap((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const centroid = asNumberArray(item.centroid) ?? [];
    const members = Array.isArray(item.members)
      ? item.members.filter(
          (m): m is number =>
            Number.isInteger(m) &&
            (m as number) >= 0 &&
            (m as number) < segmentCount &&
            !seen.has(m as number)
        )
      : [];
    members.forEach((m) => seen.add(m));
    return members.length ? [{ members, centroid }] : [];
  });
};

const outputSegments = (
  request: DiarizationRequest,
  labelOf: (index: number) => string
): DiarizedOutputSegment[] =>
  request.segments.map((segment, index) => ({
    ...segment,
    speaker: labelOf(index),
    speakerLabel: labelOf(index),
  }));

export class VoiceDiarizationProvider implements DiarizationProvider {
  readonly name = "voice";

  constructor(
    private readonly baseUrl: string = env.aiServiceUrl,
    private readonly post: Poster = (url, body, config) => axios.post(url, body, config)
  ) {}

  async diarize(request: ChunkDiarizationRequest): Promise<DiarizationOutput> {
    if (!request.filePath) {
      throw new DiarizationUnavailable("No audio file to diarize.");
    }
    if (request.segments.length === 0) return { segments: [], speakers: [] };

    let data: unknown;
    try {
      ({ data } = await this.post(
        `${this.baseUrl}/diarize`,
        {
          // Multer paths are relative to the backend's working directory.
          file_path: path.resolve(request.filePath),
          offset_ms: request.offsetMs,
          channel_layout: request.channelLayout,
          segments: request.segments.map((s) => ({
            startMs: s.startMs,
            endMs: s.endMs,
          })),
        },
        { timeout: env.transcriptionTimeoutMs }
      ));
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const code = axios.isAxiosError(error) ? error.code : undefined;
      throw new DiarizationUnavailable(
        `Voice diarization unavailable (${status ?? code ?? "error"}).`
      );
    }

    const clusters = parseVoiceClusters(data, request.segments.length);
    const labels = new Map<number, string>();
    clusters.forEach((cluster, n) =>
      cluster.members.forEach((m) => labels.set(m, `c${n}`))
    );

    return {
      segments: outputSegments(request, (i) => labels.get(i) ?? UNATTRIBUTED),
      speakers: clusters.map((cluster, n) => ({
        label: `c${n}`,
        displayName: null,
        centroid: cluster.centroid,
      })),
    };
  }
}

export class TextDiarizationProvider implements DiarizationProvider {
  readonly name = "text";

  constructor(private readonly label = labelWithGemini) {}

  async diarize(request: ChunkDiarizationRequest): Promise<DiarizationOutput> {
    if (request.segments.length === 0) return { segments: [], speakers: [] };

    const labels = await this.label(
      request.segments,
      request.context ?? [],
      request.knownLabels ?? []
    );

    return {
      segments: outputSegments(request, (i) => labels[i]),
      speakers: [...new Set(labels)].map((label) => ({
        label,
        displayName: null,
        centroid: [],
      })),
    };
  }
}

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

/**
 * Deepgram diarization of the chunk's file. Paid; only constructed when
 * DIARIZATION_PROVIDER=deepgram (env.ts requires DEEPGRAM_API_KEY then).
 * Each request segment takes the Deepgram speaker that overlaps it most
 * (on the remote channel for stereo).
 */
export class DeepgramDiarizationProvider implements DiarizationProvider {
  readonly name = "deepgram";

  constructor(
    private readonly apiKey: string | null = env.deepgramApiKey,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async diarize(request: ChunkDiarizationRequest): Promise<DiarizationOutput> {
    if (!this.apiKey || !request.filePath) {
      throw new DiarizationUnavailable("Deepgram diarization is not configured.");
    }
    if (request.segments.length === 0) return { segments: [], speakers: [] };

    const stereo = request.channelLayout === "stereo-mic-left";
    const params = new URLSearchParams({
      model: env.deepgramModel,
      diarize: "true",
      utterances: "true",
      ...(stereo ? { multichannel: "true" } : {}),
    });

    let body: unknown;
    try {
      const response = await this.fetchImpl(`${DEEPGRAM_URL}?${params}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: await fs.readFile(request.filePath),
        signal: AbortSignal.timeout(env.transcriptionTimeoutMs),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      body = await response.json();
    } catch {
      throw new DiarizationUnavailable("Deepgram diarization failed.");
    }

    const turns = parseDeepgramTurns(body, request.offsetMs, stereo ? 1 : null);
    const labels = request.segments.map((segment) => {
      const overlap = new Map<number, number>();
      for (const turn of turns) {
        const shared =
          Math.min(segment.endMs, turn.endMs) - Math.max(segment.startMs, turn.startMs);
        if (shared > 0) overlap.set(turn.speaker, (overlap.get(turn.speaker) ?? 0) + shared);
      }
      const best = [...overlap.entries()].sort((a, b) => b[1] - a[1])[0];
      return best ? `Speaker ${best[0] + 1}` : UNATTRIBUTED;
    });

    return {
      segments: outputSegments(request, (i) => labels[i]),
      speakers: [...new Set(labels.filter(Boolean))].map((label) => ({
        label,
        displayName: null,
        centroid: [],
      })),
    };
  }
}

/** Deepgram utterances -> speaker turns on the meeting timeline. */
export const parseDeepgramTurns = (
  body: unknown,
  offsetMs: number,
  channel: number | null
): { speaker: number; startMs: number; endMs: number }[] => {
  const utterances = (body as { results?: { utterances?: unknown } } | null)
    ?.results?.utterances;
  if (!Array.isArray(utterances)) return [];

  return utterances.flatMap((raw) => {
    const u = (raw ?? {}) as Record<string, unknown>;
    const speaker = Number(u.speaker);
    const start = Number(u.start);
    const end = Number(u.end);
    if (!Number.isInteger(speaker) || !Number.isFinite(start) || !Number.isFinite(end)) {
      return [];
    }
    if (channel !== null && Number(u.channel) !== channel) return [];
    return [
      {
        speaker,
        startMs: Math.round(start * 1000) + offsetMs,
        endMs: Math.round(end * 1000) + offsetMs,
      },
    ];
  });
};

export type DiarizationProviderName = "voice" | "text" | "deepgram";

export const createDiarizationProvider = (
  name: DiarizationProviderName
): DiarizationProvider => {
  switch (name) {
    case "deepgram":
      return new DeepgramDiarizationProvider();
    case "text":
      return new TextDiarizationProvider();
    default:
      return new VoiceDiarizationProvider();
  }
};
