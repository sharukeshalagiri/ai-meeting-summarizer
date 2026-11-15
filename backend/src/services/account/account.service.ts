import { env } from "../../lib/env";
import { isValidTimezone } from "../../lib/dates";
import * as userRepo from "../../repositories/user.repository";
import { MEETING_MODES, type MeetingMode } from "../../types/capture";
import { BadRequest, NotFound } from "../../types/errors";

/**
 * Account settings (Settings page) and the per-meeting view of them
 * that processing uses (services/account/context.ts).
 */

export const RETENTION_POLICIES = ["KEEP", "AFTER_PROCESSING", "AFTER_DAYS"] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

export const TRANSCRIPTION_PROVIDERS = ["local", "deepgram"] as const;

export const GLOSSARY_LIMITS = { terms: 200, termLength: 80 } as const;
export const MAX_RETENTION_DAYS = 3650;

/** Providers the server can actually run, for the Settings picker. */
export const availableProviders = (): string[] =>
  env.deepgramApiKey ? ["local", "deepgram"] : ["local"];

export const getAccount = async (userId: string) => {
  const user = await userRepo.findById(userId);
  if (!user) throw NotFound("Account not found");

  return {
    ...user,
    meLabel: user.displayName?.trim() || env.meDisplayName,
    options: {
      modes: MEETING_MODES,
      transcriptionProviders: availableProviders(),
      serverTranscriptionProvider: env.transcriptionProvider,
      retentionPolicies: RETENTION_POLICIES,
      signupEnabled: env.authAllowSignup,
      emailEnabled: Boolean(env.smtpHost),
    },
  };
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  const match =
    typeof value === "string"
      ? allowed.find((option) => option.toLowerCase() === value.trim().toLowerCase())
      : undefined;
  if (!match) throw BadRequest(`${field} must be one of: ${allowed.join(", ")}`);
  return match;
};

const nullableText = (value: unknown, field: string, maxLength: number): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") throw BadRequest(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw BadRequest(`${field} must be ${maxLength} characters or fewer`);
  return trimmed || null;
};

/** Glossary terms: trimmed, de-duplicated case-insensitively, bounded. */
export const normalizeGlossary = (value: unknown): string[] => {
  const raw =
    typeof value === "string" ? value.split(/[\n,]/) : Array.isArray(value) ? value : null;
  if (!raw) throw BadRequest("glossary must be a list of terms");

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw BadRequest("glossary must contain strings");
    const term = item.trim().slice(0, GLOSSARY_LIMITS.termLength);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }

  if (terms.length > GLOSSARY_LIMITS.terms) {
    throw BadRequest(`glossary may contain at most ${GLOSSARY_LIMITS.terms} terms`);
  }
  return terms;
};

/**
 * PATCH /account/settings. Only the fields present are changed; each is
 * validated, so a bad value is a 400 and nothing is written.
 */
export const updateSettings = async (userId: string, body: Record<string, unknown>) => {
  const data: Parameters<typeof userRepo.updateSettings>[1] = {};

  if ("name" in body) {
    const name = nullableText(body.name, "name", 120);
    if (!name) throw BadRequest("name is required");
    data.name = name;
  }
  if ("displayName" in body) data.displayName = nullableText(body.displayName, "displayName", 60);
  if ("timezone" in body) {
    const zone = nullableText(body.timezone, "timezone", 64);
    if (zone && !isValidTimezone(zone)) throw BadRequest("timezone must be an IANA zone, e.g. Europe/London");
    data.timezone = zone;
  }
  if ("defaultMode" in body) data.defaultMode = pick<MeetingMode>(body.defaultMode, MEETING_MODES, "defaultMode");
  if ("transcriptionProvider" in body) {
    if (body.transcriptionProvider === null || body.transcriptionProvider === "") {
      data.transcriptionProvider = null;
    } else {
      const provider = pick(body.transcriptionProvider, TRANSCRIPTION_PROVIDERS, "transcriptionProvider");
      if (!availableProviders().includes(provider)) {
        throw BadRequest("Deepgram is not configured on this server (DEEPGRAM_API_KEY).");
      }
      data.transcriptionProvider = provider;
    }
  }
  if ("glossary" in body) data.glossary = normalizeGlossary(body.glossary);
  if ("audioRetention" in body) data.audioRetention = pick(body.audioRetention, RETENTION_POLICIES, "audioRetention");
  if ("audioRetentionDays" in body) {
    const days = body.audioRetentionDays;
    if (days === null) data.audioRetentionDays = null;
    else if (typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS) {
      data.audioRetentionDays = days;
    } else {
      throw BadRequest(`audioRetentionDays must be a whole number from 1 to ${MAX_RETENTION_DAYS}`);
    }
  }

  // AFTER_DAYS without a day count would silently never delete.
  if (data.audioRetention === "AFTER_DAYS") {
    const current = await userRepo.findById(userId);
    const days = data.audioRetentionDays !== undefined ? data.audioRetentionDays : current?.audioRetentionDays;
    if (!days) throw BadRequest("Set audioRetentionDays to use AFTER_DAYS.");
  }

  await userRepo.updateSettings(userId, data);
  return getAccount(userId);
};
