import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import * as userRepo from "../../repositories/user.repository";

const log = logger.child({ module: "account.context" });

/**
 * The owner's settings as processing needs them, looked up from a
 * meeting (or, for an upload, its recording path).
 *
 * Settings refine processing; they must never break it. Every lookup
 * here falls back to the server defaults on any error, so a database
 * hiccup costs the user their glossary for one chunk, not the chunk.
 * test/setup.auth.ts replaces this module with the defaults, so tests
 * that predate accounts need no database.
 */

export interface ProcessingSettings {
  userId: string;
  /** Label for the user's own (mic) segments: displayName or "You". */
  meLabel: string;
  timezone: string | null;
  /** "local" | "deepgram" | null (server default). */
  transcriptionProvider: string | null;
  glossary: string[];
}

type SettingsRow = NonNullable<Awaited<ReturnType<typeof userRepo.findSettingsByMeetingId>>>;

const toSettings = (row: SettingsRow): ProcessingSettings => ({
  userId: row.id,
  meLabel: row.displayName?.trim() || env.meDisplayName,
  timezone: row.timezone,
  transcriptionProvider: row.transcriptionProvider,
  glossary: row.glossary ?? [],
});

const safely = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    log.warn("Account settings lookup failed; using defaults", { what, reason: String(error) });
    return fallback;
  }
};

export const settingsForMeeting = (meetingId: string): Promise<ProcessingSettings | null> =>
  safely(
    "meeting",
    async () => {
      const row = await userRepo.findSettingsByMeetingId(meetingId);
      return row ? toSettings(row) : null;
    },
    null
  );

export const settingsForAudioPath = (audioPath: string): Promise<ProcessingSettings | null> =>
  safely(
    "audioPath",
    async () => {
      const row = await userRepo.findSettingsByAudioPath(audioPath);
      return row ? toSettings(row) : null;
    },
    null
  );

/** The "You" label for a meeting's mic segments. */
export const meLabelForMeeting = async (meetingId: string | null | undefined): Promise<string> =>
  meetingId ? (await settingsForMeeting(meetingId))?.meLabel ?? env.meDisplayName : env.meDisplayName;

/** The user's default mode, or null for "no preference" (AUTO). */
export const defaultModeFor = (userId: string): Promise<string | null> =>
  safely(
    "defaultMode",
    async () => {
      const mode = (await userRepo.findById(userId))?.defaultMode;
      return mode && mode !== "AUTO" ? mode : null;
    },
    null
  );
