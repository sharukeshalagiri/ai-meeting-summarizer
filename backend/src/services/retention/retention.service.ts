import fs from "fs/promises";
import path from "path";
import { logger } from "../../lib/logger";
import * as retentionRepo from "../../repositories/retention.repository";
import * as userRepo from "../../repositories/user.repository";

const log = logger.child({ module: "retention.service" });

/**
 * Audio retention (Settings): KEEP, AFTER_PROCESSING, or AFTER_DAYS.
 *
 * Runs as the scheduled `audio-retention` job (jobs/definitions.ts,
 * hourly by default, RETENTION_CRON). Only recordings are deleted: the
 * transcript, summary, tasks and search index stay, which is the point
 * of the setting ("keep what was said, not the audio"). Playback then
 * answers 404 and MeetingDetails says the recording was removed.
 *
 * Idempotent: a meeting is marked (audioDeletedAt) only after its files
 * are gone, and a file that is already missing counts as deleted, so a
 * run that dies half way is finished by the next one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Meetings handled per user per run; the next run takes the rest. */
const BATCH = 200;

export interface RetentionDeps {
  users: Pick<typeof userRepo, "findWithRetention">;
  meetings: Pick<typeof retentionRepo, "findAudioToDelete" | "markAudioDeleted">;
  removeFile: (absolutePath: string) => Promise<void>;
}

/** ENOENT is success: the goal is "the file does not exist". */
const removeIfPresent = async (absolutePath: string) => {
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const defaultDeps: RetentionDeps = {
  users: userRepo,
  meetings: retentionRepo,
  removeFile: removeIfPresent,
};

/** The cut-off for a policy, or undefined for "any finished meeting". */
export const cutoffFor = (
  policy: { audioRetention: string; audioRetentionDays: number | null },
  now: Date
): Date | undefined | null => {
  if (policy.audioRetention === "AFTER_PROCESSING") return undefined;
  if (policy.audioRetention === "AFTER_DAYS" && policy.audioRetentionDays && policy.audioRetentionDays > 0) {
    return new Date(now.getTime() - policy.audioRetentionDays * DAY_MS);
  }
  // KEEP, or AFTER_DAYS without a day count: delete nothing.
  return null;
};

export const sweepAudio = async (
  now = new Date(),
  deps: RetentionDeps = defaultDeps
): Promise<{ meetings: number; files: number; failed: number }> => {
  let meetings = 0;
  let files = 0;
  let failed = 0;

  for (const user of await deps.users.findWithRetention()) {
    const olderThan = cutoffFor(user, now);
    if (olderThan === null) continue;

    const due = await deps.meetings.findAudioToDelete({ userId: user.id, olderThan, limit: BATCH });

    for (const meeting of due) {
      const paths = [
        meeting.audioPath,
        ...(meeting.liveSession?.chunks.map((chunk) => chunk.path) ?? []),
      ].filter((p): p is string => Boolean(p));

      try {
        for (const file of paths) {
          // Stored paths are relative to the backend's working directory.
          await deps.removeFile(path.resolve(file));
          files += 1;
        }
        await deps.meetings.markAudioDeleted(meeting.id, now);
        meetings += 1;
      } catch (error) {
        // One unreadable file must not stop the sweep; it is retried
        // on the next run because the meeting is not marked.
        failed += 1;
        log.warn("Could not delete a recording", { meetingId: meeting.id, reason: String(error) });
      }
    }
  }

  if (meetings || failed) log.info("Audio retention sweep", { meetings, files, failed });

  return { meetings, files, failed };
};
