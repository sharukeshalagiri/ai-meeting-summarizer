import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import * as profileRepo from "../../repositories/speakerProfile.repository";
import * as segmentRepo from "../../repositories/segment.repository";
import type { ChannelLayout } from "../../types/capture";
import type { DiarizationOutput, DiarizationProvider } from "../../types/providers";
import type { DiarizedSegment, RawSegment } from "../../types/segment";
import { withMeetingLock } from "./lock";
import {
  CONTINUITY_MS,
  matchClusters,
  nextSpeakerLabel,
  normalize,
  updateCentroid,
  type ClusterVoice,
} from "./matcher";
import { mentionsAName, suggestNames } from "./names";
import {
  createDiarizationProvider,
  TextDiarizationProvider,
  UNATTRIBUTED,
  type ChunkDiarizationRequest,
} from "./providers";
import { CONTEXT_SIZE } from "./textLabels";

const log = logger.child({ module: "speakers.attribute" });

/** SpeakerProfile.label of the user's own (mic channel) voice. */
export const MIC_LABEL = "mic";

/** A segment with its resolved SpeakerProfile. */
export type AttributedSegment = DiarizedSegment & { speakerId?: string };

/** What live capture knows about a chunk. */
export interface SpeakerContext {
  meetingId: string;
  /** The chunk's audio, for voice diarization. */
  filePath?: string | null;
  channelLayout?: ChannelLayout;
  /** Meeting-timeline position of the file's first sample. */
  offsetMs?: number;
  roster?: string[];
  /** The previous chunk's stored segments (labels, for continuity). */
  previous?: {
    speaker: string;
    text: string;
    channel?: string | null;
    speakerId?: string | null;
  }[];
}

interface Profile {
  id: string;
  label: string;
  displayName: string | null;
  centroid: number[];
  source: string;
}

/** The repository functions this module uses (injectable for tests). */
export interface SpeakerDeps {
  profiles: Pick<
    typeof profileRepo,
    | "findByMeetingId"
    | "create"
    | "updateCentroid"
    | "setDisplayName"
    | "assignSegments"
    | "renameSegmentsOf"
  >;
  segments: Pick<typeof segmentRepo, "findByMeetingId">;
  provider: () => DiarizationProvider;
  fallback: () => DiarizationProvider;
}

let cachedProvider: DiarizationProvider | null = null;

export const defaultDeps: SpeakerDeps = {
  profiles: profileRepo,
  segments: segmentRepo,
  provider: () =>
    (cachedProvider ??= createDiarizationProvider(env.diarizationProvider)),
  fallback: () => new TextDiarizationProvider(),
};

export const shownName = (profile: Profile): string =>
  profile.displayName ??
  (profile.label === MIC_LABEL ? env.meDisplayName : profile.label);

const isMic = (profile: Profile) => profile.label === MIC_LABEL;

/**
 * Runs the configured provider, then text diarization if that fails
 * (voice: ai-service down or no model). Null when both fail: the caller
 * then attributes by continuity rather than losing the chunk.
 */
const diarizeRemote = async (
  request: ChunkDiarizationRequest,
  deps: SpeakerDeps
): Promise<DiarizationOutput | null> => {
  const provider = deps.provider();

  try {
    return await provider.diarize(request);
  } catch (error) {
    log.warn("Diarization provider failed; trying text diarization", {
      provider: provider.name,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (provider.name === "text") return null;

  try {
    return await deps.fallback().diarize(request);
  } catch (error) {
    log.warn("Text diarization failed; attributing by continuity", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

/**
 * Attributes one chunk's segments to the meeting's SpeakerProfiles.
 *
 * - "mic" segments are the user (profile `mic`, shown as its display
 *   name or ME_DISPLAY_NAME). Echo of remote speech on the mic was
 *   already removed by the ASR (w1-asr).
 * - Remote (or mono) segments are diarized by the provider into
 *   chunk-local clusters, which are matched to the meeting's profiles
 *   by voice centroid (matcher.ts), or by label for text/Deepgram.
 *
 * Profiles are created and updated here; segments get `speakerId` and
 * the profile's current name. Serialised per meeting (lock.ts).
 */
export const attributeChunk = (
  segments: RawSegment[],
  context: SpeakerContext,
  deps: SpeakerDeps = defaultDeps
): Promise<AttributedSegment[]> =>
  withMeetingLock(context.meetingId, () =>
    attributeUnlocked(segments, context, deps)
  );

const attributeUnlocked = async (
  segments: RawSegment[],
  context: SpeakerContext,
  deps: SpeakerDeps
): Promise<AttributedSegment[]> => {
  if (segments.length === 0) return [];

  const { meetingId } = context;
  const profiles: Profile[] = await deps.profiles.findByMeetingId(meetingId);
  const assigned: (Profile | undefined)[] = segments.map(() => undefined);

  const createProfile = async (data: {
    label?: string;
    centroid?: number[];
  }): Promise<Profile> => {
    const created: Profile = await deps.profiles.create({
      meetingId,
      label: data.label ?? nextSpeakerLabel(profiles.map((p) => p.label)),
      centroid: data.centroid ?? [],
    });
    profiles.push(created);
    return created;
  };

  const byName = (name: string) =>
    profiles.find(
      (p) =>
        !isMic(p) &&
        (p.label.toLowerCase() === name.toLowerCase() ||
          p.displayName?.toLowerCase() === name.toLowerCase())
    );

  // 1. The user: every mic segment.
  const micIndices = segments.flatMap((s, i) => (s.channel === "mic" ? [i] : []));
  if (micIndices.length) {
    const mic =
      profiles.find(isMic) ?? (await createProfile({ label: MIC_LABEL }));
    micIndices.forEach((i) => (assigned[i] = mic));
  }

  // 2. Everyone else.
  const remoteIndices = segments.flatMap((s, i) => (s.channel === "mic" ? [] : [i]));

  if (remoteIndices.length) {
    const remote = remoteIndices.map((i) => segments[i]);
    const chunkStartMs =
      context.offsetMs ?? Math.min(...remote.map((s) => s.startMs));

    const previousRemote = [...(context.previous ?? [])]
      .reverse()
      .find((s) => s.channel !== "mic" && s.speakerId);
    const previousProfile = previousRemote
      ? profiles.find((p) => p.id === previousRemote.speakerId)
      : undefined;

    const output = await diarizeRemote(
      {
        meetingId,
        segments: remote.map((s) => ({
          text: s.text,
          startMs: s.startMs,
          endMs: s.endMs,
          channel: s.channel ?? null,
        })),
        filePath: context.filePath ?? null,
        channelLayout: context.channelLayout ?? "mono",
        roster: context.roster ?? [],
        offsetMs: context.offsetMs ?? 0,
        context: (context.previous ?? [])
          .slice(-CONTEXT_SIZE)
          .map((s) => ({ speaker: s.speaker, text: s.text })),
        knownLabels: profiles.filter((p) => !isMic(p)).map(shownName),
      },
      deps
    );

    const local: (Profile | undefined)[] = remote.map(() => undefined);

    if (output) {
      const voiced = output.speakers.filter((s) => s.centroid.length > 0);

      // Voice clusters: match to profiles by centroid.
      if (voiced.length) {
        const clusters: ClusterVoice[] = voiced.map((speaker) => {
          const members = output.segments.flatMap((s, i) =>
            s.speakerLabel === speaker.label ? [i] : []
          );
          return {
            centroid: speaker.centroid,
            speechMs: members.reduce(
              (sum, i) => sum + Math.max(0, remote[i].endMs - remote[i].startMs),
              0
            ),
            startMs: Math.min(...members.map((i) => remote[i].startMs)),
          };
        });

        const matches = matchClusters(
          profiles
            .filter((p) => !isMic(p))
            .map((p) => ({ id: p.id, centroid: p.centroid })),
          clusters,
          { chunkStartMs, previousSpeakerId: previousProfile?.id ?? null }
        );

        for (const [n, match] of matches.entries()) {
          let profile: Profile;

          if (match.kind === "match") {
            profile = profiles.find((p) => p.id === match.profileId)!;
            if (match.update) {
              const centroid = updateCentroid(
                profile.centroid,
                clusters[n].centroid,
                clusters[n].speechMs
              );
              await deps.profiles.updateCentroid(profile.id, centroid);
              profile.centroid = centroid;
            }
          } else {
            profile = await createProfile({
              centroid: normalize(clusters[n].centroid),
            });
          }

          output.segments.forEach((s, i) => {
            if (s.speakerLabel === voiced[n].label) local[i] = profile;
          });
        }
      }

      // Label-only speakers (text, Deepgram): match by name.
      for (const speaker of output.speakers.filter((s) => s.centroid.length === 0)) {
        if (!speaker.label || speaker.label === UNATTRIBUTED) continue;
        const label =
          speaker.label.toLowerCase() === MIC_LABEL ? undefined : speaker.label;
        const profile =
          (label ? byName(label) : undefined) ??
          (await createProfile({ label }));
        output.segments.forEach((s, i) => {
          if (s.speakerLabel === speaker.label) local[i] = profile;
        });
      }
    }

    // Segments nobody attributed (too short to embed, or no provider):
    // the nearest attributed segment in this chunk if close in time,
    // else the previous chunk's last remote speaker at the boundary,
    // else the nearest in this chunk, else the meeting's first remote
    // profile, else a new one.
    for (let i = 0; i < remote.length; i++) {
      if (local[i]) continue;

      const nearest = remote
        .map((s, j) => ({ j, gap: Math.abs(s.startMs - remote[i].startMs) }))
        .filter(({ j }) => local[j] && j !== i)
        .sort((a, b) => a.gap - b.gap)[0];

      if (nearest && nearest.gap <= CONTINUITY_MS) {
        local[i] = local[nearest.j];
      } else if (
        previousProfile &&
        remote[i].startMs - chunkStartMs <= CONTINUITY_MS
      ) {
        local[i] = previousProfile;
      } else if (nearest) {
        local[i] = local[nearest.j];
      } else {
        local[i] =
          previousProfile ??
          profiles.find((p) => !isMic(p)) ??
          (await createProfile({}));
      }
    }

    remoteIndices.forEach((segmentIndex, k) => (assigned[segmentIndex] = local[k]));
  }

  return segments.map((segment, i) => {
    const profile = assigned[i]!;
    return { ...segment, speaker: shownName(profile), speakerId: profile.id };
  });
};

/**
 * Stores the speakerId links of segments just written (by idx), then
 * re-checks names if the new text could change one. A no-op for
 * segments with no speakerId (callers without a meeting context).
 *
 * Best effort: speaker links must never fail the chunk upload.
 */
export const linkSegmentSpeakers = async (
  meetingId: string,
  segments: { idx: number; speakerId?: string; text: string }[],
  options: { roster?: string[] } = {},
  deps: SpeakerDeps = defaultDeps
): Promise<void> => {
  const links = segments.flatMap((s) =>
    s.speakerId ? [{ idx: s.idx, speakerId: s.speakerId }] : []
  );
  if (links.length === 0) return;

  try {
    await deps.profiles.assignSegments(meetingId, links);

    if (segments.some((s) => mentionsAName(s.text))) {
      await applyAutoNames(meetingId, options.roster ?? [], deps);
    }
  } catch (error) {
    log.warn("Could not link segment speakers", {
      meetingId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Applies the names that have two agreeing signals (names.ts) to
 * profiles that have no name yet. Never overrides a user's rename
 * (source MANUAL) or an existing name; never names the user's mic.
 * Returns the names applied.
 */
export const applyAutoNames = (
  meetingId: string,
  roster: string[],
  deps: SpeakerDeps = defaultDeps
): Promise<{ speakerId: string; name: string }[]> =>
  withMeetingLock(meetingId, async () => {
    const profiles: Profile[] = await deps.profiles.findByMeetingId(meetingId);
    const rows = await deps.segments.findByMeetingId(meetingId);

    const mic = profiles.find(isMic);
    const suggestions = suggestNames(
      rows.map((row) => ({
        idx: row.idx,
        speakerId: row.speakerId ?? null,
        channel: row.channel,
        text: row.text,
      })),
      roster,
      [env.meDisplayName, ...(mic?.displayName ? [mic.displayName] : [])]
    );

    const applied: { speakerId: string; name: string }[] = [];

    for (const suggestion of suggestions) {
      if (!suggestion.autoApply) continue;
      const profile = profiles.find((p) => p.id === suggestion.speakerId);
      if (!profile || isMic(profile) || profile.displayName || profile.source === "MANUAL") {
        continue;
      }

      await deps.profiles.setDisplayName(profile.id, suggestion.name);
      await deps.profiles.renameSegmentsOf(meetingId, profile.id, suggestion.name);
      applied.push({ speakerId: profile.id, name: suggestion.name });

      log.info("Speaker name applied", {
        meetingId,
        speakerId: profile.id,
        signals: suggestion.signals,
      });
    }

    return applied;
  });
