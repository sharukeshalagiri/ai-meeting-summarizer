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

/**
 * A chunk-level result: providers that cut segments into speaker turns
 * (voice) also return `pieces`, each a span of one request segment with
 * its own request-local label. `segments` keeps the interface's
 * one-label-per-segment view (the label of the segment's longest piece).
 */
export interface ChunkDiarizationOutput extends DiarizationOutput {
  pieces?: {
    /** Index into the request's segments. */
    segment: number;
    startMs: number;
    endMs: number;
    speakerLabel: string;
  }[];
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
 * Validates the ai-service response; never trusts its shape. Cluster
 * members index into `pieces` (speaker-turn spans of the request's
 * segments); an older response without `pieces` indexes segments, which
 * is read as one piece per segment. Exported for tests.
 */
export const parseVoiceResponse = (
  body: unknown,
  segments: { startMs: number; endMs: number }[]
): {
  pieces: { segment: number; startMs: number; endMs: number }[];
  clusters: { members: number[]; centroid: number[] }[];
} => {
  const root = (body ?? {}) as { clusters?: unknown; pieces?: unknown };
  if (!Array.isArray(root.clusters)) {
    throw new Error("Diarization service returned an unexpected response.");
  }

  const pieces = Array.isArray(root.pieces)
    ? root.pieces.flatMap((raw) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const segment = Number(item.segment);
        const startMs = Number(item.startMs);
        const endMs = Number(item.endMs);
        return Number.isInteger(segment) &&
          segment >= 0 &&
          segment < segments.length &&
          Number.isFinite(startMs) &&
          Number.isFinite(endMs) &&
          endMs >= startMs
          ? [{ segment, startMs, endMs }]
          : [{ segment: -1, startMs: 0, endMs: 0 }]; // keeps member indices aligned
      })
    : segments.map((s, i) => ({ segment: i, startMs: s.startMs, endMs: s.endMs }));

  const seen = new Set<number>();
  const clusters = root.clusters.flatMap((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const centroid = asNumberArray(item.centroid) ?? [];
    const members = Array.isArray(item.members)
      ? item.members.filter(
          (m): m is number =>
            Number.isInteger(m) &&
            (m as number) >= 0 &&
            (m as number) < pieces.length &&
            pieces[m as number].segment >= 0 &&
            !seen.has(m as number)
        )
      : [];
    members.forEach((m) => seen.add(m));
    return members.length ? [{ members, centroid }] : [];
  });

  return { pieces, clusters };
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

  async diarize(request: ChunkDiarizationRequest): Promise<ChunkDiarizationOutput> {
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
          // Word timings let the ai-service cut a segment into turns.
          segments: request.segments.map((s) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            words: (s.words ?? []).map((w) => ({
              startMs: w.startMs,
              endMs: w.endMs,
            })),
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

    const { pieces, clusters } = parseVoiceResponse(data, request.segments);
    const pieceLabel = new Map<number, string>();
    clusters.forEach((cluster, n) =>
      cluster.members.forEach((m) => pieceLabel.set(m, `c${n}`))
    );

    const labelled = pieces.flatMap((piece, k) =>
      piece.segment >= 0
        ? [{ ...piece, speakerLabel: pieceLabel.get(k) ?? UNATTRIBUTED }]
        : []
    );

    // Per segment, the label of its longest attributed piece.
    const segmentLabel = (i: number) =>
      labelled
        .filter((p) => p.segment === i && p.speakerLabel)
        .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))[0]
        ?.speakerLabel ?? UNATTRIBUTED;

    return {
      segments: outputSegments(request, segmentLabel),
      pieces: labelled,
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
