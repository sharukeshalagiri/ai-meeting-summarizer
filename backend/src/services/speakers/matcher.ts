/**
 * Cross-chunk speaker matching (pure; no I/O).
 *
 * The ai-service clusters voices *within* one chunk. This module keeps
 * labels stable *across* chunks by matching each chunk cluster to the
 * meeting's SpeakerProfile centroids. It is what fixes the chunk-boundary
 * split ("Speaker 2" in chunk n, a new label in chunk n+1 for the same
 * voice): labels now come from the meeting's profiles, not from one
 * chunk's guess. Thresholds are named constants calibrated by the bench
 * (docs/decisions/w2-spk.md).
 */

/** Cosine similarity at which a chunk cluster is a known speaker. */
export const MATCH_SIMILARITY = 0.55;

/**
 * A match must beat the cluster's second-best profile by this much to
 * also move that profile's centroid. An ambiguous match is still used
 * for the label (creating a third profile would be worse), but it does
 * not drag one profile's centroid toward its neighbour.
 */
export const UPDATE_MARGIN = 0.05;

/** Clusters with less speech than this get looser, label-only rules. */
export const SHORT_CLUSTER_MS = 1000;

/** Looser threshold for short clusters (noisy embeddings). */
export const SHORT_MATCH_SIMILARITY = 0.4;

/**
 * A short cluster starting this close to the chunk start continues the
 * previous chunk's last remote speaker: a sentence cut by the boundary.
 */
export const CONTINUITY_MS = 1500;

/** Centroid update weight bounds (see updateCentroid). */
export const MIN_UPDATE_WEIGHT = 0.05;
export const MAX_UPDATE_WEIGHT = 0.5;
/** Speech duration at which a cluster weighs half as much as the profile. */
export const UPDATE_HALF_WEIGHT_MS = 20_000;

export interface ProfileVoice {
  id: string;
  centroid: number[];
}

export interface ClusterVoice {
  centroid: number[];
  speechMs: number;
  /** First member's start on the meeting timeline. */
  startMs: number;
}

export type ClusterMatch =
  | {
      kind: "match";
      profileId: string;
      similarity: number;
      /** Move the profile centroid toward this cluster. */
      update: boolean;
      /** The profile had no centroid yet and adopts this one. */
      adopted?: boolean;
    }
  | { kind: "new" };

export const cosine = (a: number[], b: number[]): number => {
  if (a.length === 0 || a.length !== b.length) return Number.NaN;

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  if (na === 0 || nb === 0) return Number.NaN;
  return dot / Math.sqrt(na * nb);
};

export const normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
};

/**
 * Exponential moving average of the profile centroid, weighted by how
 * much speech the new cluster has: a = clamp(ms / (ms + 20 s), 0.05,
 * 0.5). A long monologue moves the centroid more than a two-second
 * reply, and the 0.5 cap keeps one chunk from replacing a voice that has
 * been heard for minutes. EMA needs no per-profile count, so it fits the
 * existing schema (SpeakerProfile.centroid only).
 */
export const updateCentroid = (
  current: number[],
  incoming: number[],
  speechMs: number
): number[] => {
  if (current.length !== incoming.length || current.length === 0) {
    return normalize(incoming);
  }

  const raw = speechMs / (speechMs + UPDATE_HALF_WEIGHT_MS);
  const a = Math.min(MAX_UPDATE_WEIGHT, Math.max(MIN_UPDATE_WEIGHT, raw));

  return normalize(current.map((c, i) => (1 - a) * c + a * incoming[i]));
};

/**
 * Matches one chunk's clusters to the meeting's profiles, one-to-one.
 *
 * - Long clusters (>= 1 s): greedy by similarity, best pair first,
 *   accepted at >= MATCH_SIMILARITY. Centroid updated only when the
 *   match beats the second-best profile by UPDATE_MARGIN.
 * - Short clusters: >= SHORT_MATCH_SIMILARITY, else the previous chunk's
 *   last remote speaker if the cluster starts within CONTINUITY_MS of
 *   the chunk start, else new. Short clusters never move a centroid.
 * - A long cluster that matches nothing adopts a profile that has no
 *   centroid yet (created by the label fallback), else it is new.
 * - Cold start (no profiles): every cluster is new.
 */
export const matchClusters = (
  profiles: ProfileVoice[],
  clusters: ClusterVoice[],
  options: { chunkStartMs: number; previousSpeakerId?: string | null }
): ClusterMatch[] => {
  const result: (ClusterMatch | null)[] = clusters.map(() => null);
  const used = new Set<string>();

  const voiced = profiles.filter((p) => p.centroid.length > 0);

  const similarities = clusters.map((cluster) =>
    voiced.map((profile) => cosine(cluster.centroid, profile.centroid))
  );

  const secondBest = (clusterIndex: number, exceptProfile: number) =>
    similarities[clusterIndex].reduce(
      (best, sim, j) =>
        j !== exceptProfile && Number.isFinite(sim) && sim > best ? sim : best,
      -1
    );

  // Long clusters first, best pairs first.
  const pairs: { c: number; p: number; sim: number }[] = [];
  clusters.forEach((cluster, c) => {
    if (cluster.speechMs < SHORT_CLUSTER_MS) return;
    similarities[c].forEach((sim, p) => {
      if (Number.isFinite(sim)) pairs.push({ c, p, sim });
    });
  });
  pairs.sort((x, y) => y.sim - x.sim);

  for (const { c, p, sim } of pairs) {
    if (result[c] || used.has(voiced[p].id) || sim < MATCH_SIMILARITY) continue;

    result[c] = {
      kind: "match",
      profileId: voiced[p].id,
      similarity: sim,
      update: sim - secondBest(c, p) >= UPDATE_MARGIN,
    };
    used.add(voiced[p].id);
  }

  // Unmatched long clusters may adopt a centroid-less profile.
  const silent = profiles.filter((p) => p.centroid.length === 0);
  clusters.forEach((cluster, c) => {
    if (result[c] || cluster.speechMs < SHORT_CLUSTER_MS) return;
    const free = silent.find((p) => !used.has(p.id));
    if (!free) return;
    result[c] = {
      kind: "match",
      profileId: free.id,
      similarity: Number.NaN,
      update: true,
      adopted: true,
    };
    used.add(free.id);
  });

  // Short clusters: looser threshold, then boundary continuity.
  clusters.forEach((cluster, c) => {
    if (result[c] || cluster.speechMs >= SHORT_CLUSTER_MS) return;

    let best = -1;
    let bestIndex = -1;
    similarities[c].forEach((sim, p) => {
      if (Number.isFinite(sim) && !used.has(voiced[p].id) && sim > best) {
        best = sim;
        bestIndex = p;
      }
    });

    if (bestIndex >= 0 && best >= SHORT_MATCH_SIMILARITY) {
      result[c] = {
        kind: "match",
        profileId: voiced[bestIndex].id,
        similarity: best,
        update: false,
      };
      used.add(voiced[bestIndex].id);
      return;
    }

    const previous = options.previousSpeakerId;
    if (
      previous &&
      !used.has(previous) &&
      cluster.startMs - options.chunkStartMs <= CONTINUITY_MS
    ) {
      result[c] = {
        kind: "match",
        profileId: previous,
        similarity: Number.NaN,
        update: false,
      };
      used.add(previous);
    }
  });

  return result.map((match) => match ?? { kind: "new" });
};

/** Next free "Speaker N" label in a meeting. */
export const nextSpeakerLabel = (labels: Iterable<string>): string => {
  let max = 0;
  for (const label of labels) {
    const match = /^Speaker (\d+)$/.exec(label);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Speaker ${max + 1}`;
};
