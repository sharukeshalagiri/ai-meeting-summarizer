import type { Prisma } from "@prisma/client";
import { logger } from "../../lib/logger";
import * as actionItemRepo from "../../repositories/actionItem.repository";
import * as correctionRepo from "../../repositories/correction.repository";
import * as seriesRepo from "../../repositories/series.repository";
import * as summaryRepo from "../../repositories/summary.repository";
import { AppError, BadRequest, NotFound } from "../../types/errors";
import { isSummaryV2 } from "../../types/summary";
import { assertActionItemOwner } from "../account/access.service";
import { readSinceLastTime } from "./sinceLastTime";

const log = logger.child({ module: "series.service" });

/**
 * Meeting series: a recurring meeting (weekly 1:1, project sync) whose
 * meetings are linked, so a summary can report what changed since last
 * time, the Prep view can gather what is still open, and Ask can be
 * limited to the series. Every function takes the owner's userId.
 */

export const CORRECTION_SINCE_LAST_TIME = "SINCE_LAST_TIME";

const cleanName = (name: string) => {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw BadRequest("Give the series a name.");
  if (trimmed.length > 120) throw BadRequest("Series names are at most 120 characters.");
  return trimmed;
};

export const listSeries = async (userId: string) =>
  (await seriesRepo.findByUser(userId)).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    meetingCount: row._count.meetings,
    lastMeeting: row.meetings[0] ?? null,
  }));

export const createSeries = async (userId: string, name: string) => {
  const clean = cleanName(name);
  if (await seriesRepo.findByName(userId, clean)) {
    throw new AppError("You already have a series with that name.", 409);
  }
  return seriesRepo.create(userId, clean);
};

export const renameSeries = async (userId: string, seriesId: string, name: string) => {
  const clean = cleanName(name);
  const clash = await seriesRepo.findByName(userId, clean);
  if (clash && clash.id !== seriesId) {
    throw new AppError("You already have a series with that name.", 409);
  }
  const { count } = await seriesRepo.rename(seriesId, userId, clean);
  if (!count) throw NotFound("Series not found");
  return seriesRepo.findOwned(seriesId, userId);
};

/**
 * Puts a meeting in a series (by id, or by name, creating it), or takes
 * it out with both null. The meeting's ownership was checked by the
 * /meetings/:id guard; the series is checked here.
 */
export const setMeetingSeries = async (
  userId: string,
  meetingId: string,
  input: { seriesId: string | null; name: string | null }
) => {
  let seriesId: string | null = null;

  if (input.seriesId) {
    const series = await seriesRepo.findOwned(input.seriesId, userId);
    if (!series) throw NotFound("Series not found");
    seriesId = series.id;
  } else if (input.name) {
    const clean = cleanName(input.name);
    seriesId = ((await seriesRepo.findByName(userId, clean)) ?? (await seriesRepo.create(userId, clean))).id;
  }

  const { count } = await seriesRepo.setMeetingSeries(meetingId, userId, seriesId);
  if (!count) throw NotFound("Meeting not found");

  log.info("Meeting series set", { meetingId, seriesId });

  return { meetingId, seriesId };
};

const textsOf = (items: unknown): string[] =>
  Array.isArray(items)
    ? items.flatMap((item) => {
        const text = typeof item === "string" ? item : (item as { text?: unknown })?.text;
        return typeof text === "string" && text.trim() ? [text.trim()] : [];
      })
    : [];

/**
 * Prep view: everything worth reading before the next meeting of the
 * series. Open items across the series, and from the latest meeting its
 * decisions, open questions and "prepare for next time" list.
 */
export const getPrep = async (userId: string, seriesId: string) => {
  const series = await seriesRepo.findOwned(seriesId, userId);
  if (!series) throw NotFound("Series not found");

  const [meetings, openItems] = await Promise.all([
    seriesRepo.findMeetings(seriesId, userId),
    seriesRepo.findOpenItems(seriesId, userId),
  ]);

  const latest = [...meetings].reverse().find((meeting) => meeting.summary?.data) ?? null;
  const data = latest?.summary?.data;
  const v2 = isSummaryV2(data) ? data : null;
  const legacy = !v2 && data && typeof data === "object" ? (data as Record<string, unknown>) : null;

  return {
    series: { id: series.id, name: series.name },
    meetings: meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      createdAt: meeting.createdAt,
      status: meeting.status,
    })),
    openItems,
    latest: latest
      ? {
          id: latest.id,
          title: latest.title,
          createdAt: latest.createdAt,
          tldr: v2?.tldr ?? (typeof legacy?.executiveSummary === "string" ? legacy.executiveSummary : null),
          decisions: v2 ? textsOf(v2.decisions) : textsOf(legacy?.keyDecisions),
          openQuestions: v2 ? textsOf(v2.openQuestions) : textsOf(legacy?.openQuestions),
          nextSessionPrep: v2 ? textsOf(v2.nextSessionPrep) : textsOf(legacy?.followUps),
          sinceLastTime: readSinceLastTime((data as Record<string, unknown> | null)?.sinceLastTime),
        }
      : null,
  };
};

/**
 * The user's answer to one "Since last time" suggestion. `apply` makes
 * the suggested change to the earlier meeting's action item (marks it
 * COMPLETED) and records a Correction; `dismiss` only records that the
 * suggestion was declined, so a re-summarize does not ask again.
 */
export const resolveSuggestion = async (input: {
  userId: string;
  meetingId: string;
  actionItemId: string;
  action: "apply" | "dismiss";
}) => {
  const summary = await summaryRepo.findByMeetingId(input.meetingId);
  const data = (summary?.data ?? null) as Record<string, unknown> | null;
  const since = readSinceLastTime(data?.sinceLastTime);
  const item = since?.items.find((entry) => entry.actionItemId === input.actionItemId);

  if (!summary || !data || !since || !item) throw NotFound("Suggestion not found");
  if (item.resolution) {
    return { item, actionItem: null, alreadyResolved: true };
  }

  let actionItem = null;

  if (input.action === "apply") {
    if (!item.suggestedStatus) throw BadRequest("There is no change to apply for this item.");
    // The item lives on an earlier meeting; it must be the user's too.
    await assertActionItemOwner(input.userId, item.actionItemId);
    actionItem = await actionItemRepo.updateStatus(item.actionItemId, item.suggestedStatus, new Date());
  }

  const resolved = { ...item, resolution: input.action === "apply" ? ("applied" as const) : ("dismissed" as const) };

  await summaryRepo.updateData(input.meetingId, {
    ...data,
    sinceLastTime: {
      ...since,
      items: since.items.map((entry) => (entry.actionItemId === item.actionItemId ? resolved : entry)),
    },
  } as unknown as Prisma.InputJsonObject);

  await correctionRepo.record({
    meetingId: input.meetingId,
    kind: CORRECTION_SINCE_LAST_TIME,
    targetId: item.actionItemId,
    before: { status: "PENDING", suggestedStatus: item.suggestedStatus, verdict: item.status },
    after: {
      action: input.action,
      status: input.action === "apply" ? item.suggestedStatus : "PENDING",
      evidence: item.evidence.map((e) => e.idx),
    },
  });

  return { item: resolved, actionItem, alreadyResolved: false };
};

/** Meeting ids for "Ask, limited to this series". */
export const meetingIdsFor = async (userId: string, seriesId: string) => {
  const series = await seriesRepo.findOwned(seriesId, userId);
  if (!series) throw NotFound("Series not found");
  return seriesRepo.meetingIdsInSeries(seriesId, userId);
};
