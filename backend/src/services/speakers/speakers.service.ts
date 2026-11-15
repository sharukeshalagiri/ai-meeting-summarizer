import { Prisma } from "@prisma/client";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import * as correctionRepo from "../../repositories/correction.repository";
import * as liveRepo from "../../repositories/liveSession.repository";
import * as meetingRepo from "../../repositories/meeting.repository";
import * as segmentRepo from "../../repositories/segment.repository";
import * as profileRepo from "../../repositories/speakerProfile.repository";
import { BadRequest, NotFound } from "../../types/errors";
import {
  applyOwnerNames,
  applySpeakerNames,
  buildRenameMap,
  type RenameMap,
} from "./applyNames";
import { MIC_LABEL, shownName } from "./attribute";
import { withMeetingLock } from "./lock";
import { suggestNames, type NameSuggestion } from "./names";

const log = logger.child({ module: "speakers.service" });

/**
 * Speakers of one meeting for the transcript UI: list with suggestions,
 * rename, accept a suggestion, and the read-time name projection for
 * summaries and tasks.
 *
 * Speakers are addressed by a `key`: the SpeakerProfile id, or
 * `label:<speaker>` for segments that have no profile yet (uploads and
 * meetings diarized before w2-spk). Renaming a `label:` speaker creates
 * its profile and links those segments.
 */

export const LABEL_KEY_PREFIX = "label:";

export const MAX_NAME_LENGTH = 60;

export interface SpeakerView {
  key: string;
  speakerId: string | null;
  label: string;
  name: string;
  isMe: boolean;
  source: string;
  segmentCount: number;
  suggestion: Pick<NameSuggestion, "name" | "confidence" | "signals"> | null;
}

const ensureMeeting = async (meetingId: string) => {
  if (!(await meetingRepo.exists(meetingId))) {
    throw NotFound("Meeting not found");
  }
};

const rosterOf = async (meetingId: string): Promise<string[]> =>
  (await liveRepo.findByMeetingId(meetingId))?.roster ?? [];

const keyOf = (row: { speakerId: string | null; speaker: string }) =>
  row.speakerId ?? `${LABEL_KEY_PREFIX}${row.speaker}`;

/** Speakers with their segment counts and name suggestions. */
export const listSpeakers = async (meetingId: string): Promise<SpeakerView[]> => {
  await ensureMeeting(meetingId);

  const [profiles, rows, roster] = await Promise.all([
    profileRepo.findByMeetingId(meetingId),
    segmentRepo.findByMeetingId(meetingId),
    rosterOf(meetingId),
  ]);

  const mic = profiles.find((p) => p.label === MIC_LABEL);
  const suggestions = new Map(
    suggestNames(
      rows.map((row) => ({
        idx: row.idx,
        speakerId: keyOf(row),
        channel: row.channel,
        text: row.text,
      })),
      roster,
      [env.meDisplayName, ...(mic?.displayName ? [mic.displayName] : [])]
    ).map((s) => [s.speakerId, s])
  );

  const counts = new Map<string, number>();
  const legacy = new Map<string, { channel: string | null }>();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!row.speakerId && !legacy.has(key)) legacy.set(key, { channel: row.channel });
  }

  const views: SpeakerView[] = profiles.map((profile) => ({
    key: profile.id,
    speakerId: profile.id,
    label: profile.label,
    name: shownName(profile),
    isMe: profile.label === MIC_LABEL,
    source: profile.source,
    segmentCount: counts.get(profile.id) ?? 0,
    suggestion: null,
  }));

  for (const [key, { channel }] of legacy) {
    const label = key.slice(LABEL_KEY_PREFIX.length);
    views.push({
      key,
      speakerId: null,
      label,
      name: label,
      isMe: channel === "mic",
      source: "DIARIZATION",
      segmentCount: counts.get(key) ?? 0,
      suggestion: null,
    });
  }

  for (const view of views) {
    const suggestion = suggestions.get(view.key);
    // Suggest only what is not already the speaker's name; never
    // overwrite a user's choice with a suggestion.
    if (
      suggestion &&
      !view.isMe &&
      view.source !== "MANUAL" &&
      suggestion.name.toLowerCase() !== view.name.toLowerCase()
    ) {
      view.suggestion = {
        name: suggestion.name,
        confidence: suggestion.confidence,
        signals: suggestion.signals,
      };
    }
  }

  return views.filter((v) => v.segmentCount > 0 || v.speakerId);
};

const cleanName = (raw: string): string => {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw BadRequest("A speaker name is required.");
  if (name.length > MAX_NAME_LENGTH) {
    throw BadRequest(`A speaker name can be at most ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
};

/**
 * Renames a speaker: the profile's display name (source MANUAL, so
 * diarization never overwrites it), every segment of that speaker, and
 * a SPEAKER Correction with before/after and the segment idx values.
 * Summaries and tasks pick the new name up at read time.
 */
export const renameSpeaker = async (
  meetingId: string,
  key: string,
  rawName: string,
  via: "manual" | "suggestion" = "manual"
) => {
  const name = cleanName(rawName);
  await ensureMeeting(meetingId);

  return withMeetingLock(meetingId, async () => {
    let profile;
    let before: string;

    if (key.startsWith(LABEL_KEY_PREFIX)) {
      const label = key.slice(LABEL_KEY_PREFIX.length);
      if (!label) throw BadRequest("Unknown speaker.");
      before = label;
      profile =
        (await profileRepo.findByLabel(meetingId, label)) ??
        (await profileRepo.create({ meetingId, label, source: "MANUAL" }));
      await profileRepo.setDisplayName(profile.id, name, "MANUAL");
      await profileRepo.adoptSegmentsByLabel(meetingId, label, profile.id, name);
    } else {
      profile = await profileRepo.findById(key);
      if (!profile || profile.meetingId !== meetingId) {
        throw NotFound("Speaker not found");
      }
      before = shownName(profile);
      await profileRepo.setDisplayName(profile.id, name, "MANUAL");
    }

    await profileRepo.renameSegmentsOf(meetingId, profile.id, name);
    const idx = await profileRepo.segmentIdxOf(meetingId, profile.id);

    await correctionRepo.record({
      meetingId,
      kind: "SPEAKER",
      targetId: profile.id,
      before: { speaker: before, label: profile.label, idx } as Prisma.InputJsonValue,
      after: { speaker: name, label: profile.label, idx, via } as Prisma.InputJsonValue,
    });

    log.info("Speaker renamed", { meetingId, speakerId: profile.id, via });

    return { key: profile.id, speakerId: profile.id, name, segments: idx.length };
  });
};

/** Accepts the current suggestion for a speaker (409-free: 400 if none). */
export const acceptSuggestion = async (meetingId: string, key: string) => {
  const speakers = await listSpeakers(meetingId);
  const speaker = speakers.find((s) => s.key === key);
  if (!speaker) throw NotFound("Speaker not found");
  if (!speaker.suggestion) throw BadRequest("There is no name suggestion for this speaker.");
  return renameSpeaker(meetingId, key, speaker.suggestion.name, "suggestion");
};

/**
 * Old name -> current name for one meeting: automatic names (profile
 * label -> display name) first, then the user's SPEAKER corrections in
 * order, so a later manual rename wins.
 */
export const loadSpeakerRenames = async (meetingId: string): Promise<RenameMap> => {
  const [profiles, corrections] = await Promise.all([
    profileRepo.findByMeetingId(meetingId),
    correctionRepo.findByMeetingId(meetingId),
  ]);

  const renames: { from: string; to: string }[] = profiles.flatMap((p) =>
    p.displayName && p.source !== "MANUAL" && p.label !== MIC_LABEL
      ? [{ from: p.label, to: p.displayName }]
      : []
  );

  for (const correction of corrections) {
    if (correction.kind !== "SPEAKER") continue;
    const from = (correction.before as { speaker?: unknown } | null)?.speaker;
    const to = (correction.after as { speaker?: unknown } | null)?.speaker;
    if (typeof from === "string" && typeof to === "string") {
      renames.push({ from, to });
    }
  }

  return buildRenameMap(renames);
};

/**
 * A meeting (as GET /meetings/:id returns it) with current speaker
 * names in its summary and action items. One line to wire in the
 * meeting controller; see the w2-spk PR.
 */
export const withSpeakerNames = async <
  T extends { id: string; summary?: unknown; actionItems?: unknown },
>(
  meeting: T
): Promise<T> => {
  const renames = await loadSpeakerRenames(meeting.id);
  if (renames.size === 0) return meeting;

  const rows = await segmentRepo.findByMeetingId(meeting.id);
  return applySpeakerNames(
    meeting,
    renames,
    new Map(rows.map((row) => [row.idx, row.speaker]))
  );
};

/** Action items (GET /action-items) with current owner names. */
export const withOwnerNames = async <T extends { meetingId: string }>(
  items: T[]
): Promise<T[]> => {
  const meetingIds = [...new Set(items.map((item) => item.meetingId))];
  const renames = new Map(
    await Promise.all(
      meetingIds.map(async (id) => [id, await loadSpeakerRenames(id)] as const)
    )
  );
  return applyOwnerNames(items, renames);
};
