import type { Prisma } from "@prisma/client";
import { resolveSpokenDate } from "../lib/dates";
import { logger } from "../lib/logger";
import * as actionItemRepo from "../repositories/actionItem.repository";
import * as correctionRepo from "../repositories/correction.repository";
import * as meetingRepo from "../repositories/meeting.repository";
import * as segmentRepo from "../repositories/segment.repository";
import * as summaryRepo from "../repositories/summary.repository";
import { BadRequest, NotFound } from "../types/errors";
import {
  asPriority,
  isModeSetting,
  isSummaryV2,
  normalizeModeSetting,
  toJsonValueV2,
  type ModeSetting,
  type SummaryV2,
} from "../types/summary";
import { runSummaryPipeline, type NoiseLabelUpdate } from "./summary.service";

/**
 * Meeting-level operations for summary intelligence (track w1-sum):
 * choosing the mode, re-running the v2 pipeline over stored segments,
 * and human review of action items.
 *
 * Human input is stored as Correction rows (correction.repository
 * record()), which serve two purposes: evaluation feedback, and making
 * sure a re-summarize never overwrites what a person decided.
 */

const log = logger.child({ module: "w1-sum.service" });

export const CORRECTION_KIND = {
  MODE: "MEETING_MODE",
  ACTION_ITEM: "ACTION_ITEM",
} as const;

export const REVIEW_ACTIONS = ["accept", "edit", "reject"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

type CorrectionRow = Awaited<ReturnType<typeof correctionRepo.findByMeetingId>>[number];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The mode a summary should use: the user's latest choice (a
 * MEETING_MODE correction) wins over Meeting.mode, which is what the
 * recorder sent at session start.
 */
export const effectiveModeSetting = (
  meetingMode: string | null | undefined,
  corrections: Pick<CorrectionRow, "kind" | "after">[]
): ModeSetting => {
  for (let i = corrections.length - 1; i >= 0; i--) {
    const correction = corrections[i];
    if (correction.kind !== CORRECTION_KIND.MODE) continue;

    const mode = asRecord(correction.after).mode;
    if (isModeSetting(mode)) return mode;
  }

  return normalizeModeSetting(meetingMode) ?? "AUTO";
};

/**
 * Which existing action items a human already handled. Accepted and
 * edited rows are kept as they are; rejected tasks, and the original
 * wording of edited ones, are never re-created by the model.
 */
export const reviewedActionItems = (
  corrections: Pick<CorrectionRow, "kind" | "targetId" | "before" | "after">[]
): { keepIds: string[]; suppressTasks: string[] } => {
  const keepIds = new Set<string>();
  const suppressTasks = new Set<string>();

  for (const correction of corrections) {
    if (correction.kind !== CORRECTION_KIND.ACTION_ITEM) continue;

    const action = asRecord(correction.after).action;
    const beforeTask = asRecord(correction.before).task;

    if ((action === "accept" || action === "edit") && correction.targetId) {
      keepIds.add(correction.targetId);
    }

    if ((action === "edit" || action === "reject") && typeof beforeTask === "string") {
      suppressTasks.add(beforeTask);
    }
  }

  return { keepIds: [...keepIds], suppressTasks: [...suppressTasks] };
};

/**
 * Action item rows from a v2 summary. In lecture mode homework lives in
 * sections.lecture.assignments, but it is still a task for the student,
 * so it is promoted to the task list as well.
 */
export const toActionItemInputs = (
  summary: SummaryV2
): actionItemRepo.ActionItemInput[] => {
  const evidenceJson = (evidence: SummaryV2["actionItems"][number]["evidence"]) =>
    evidence.map((entry) => ({
      idx: entry.idx,
      speaker: entry.speaker,
      startMs: entry.startMs,
    }));

  const tasks: actionItemRepo.ActionItemInput[] = summary.actionItems.map((item) => ({
    task: item.task,
    owner: item.owner,
    dueDate: item.dueDate,
    priority: item.priority,
    dueSpoken: item.dueSpoken,
    assignedBy: item.assignedBy,
    confidence: item.confidence,
    evidence: evidenceJson(item.evidence),
    needsReview: item.needsReview,
  }));

  for (const item of summary.sections.lecture?.assignments ?? []) {
    tasks.push({
      task: item.task,
      owner: null,
      dueDate: item.dueDate,
      priority: "MEDIUM",
      dueSpoken: item.dueSpoken,
      assignedBy: null,
      confidence: item.confidence,
      evidence: evidenceJson(item.evidence),
      needsReview: item.needsReview,
    });
  }

  return tasks;
};

const loadMeeting = async (meetingId: string) => {
  const meeting = await meetingRepo.findById(meetingId);
  if (!meeting) throw NotFound("Meeting not found");
  return meeting;
};

/** Summary metadata and action item rows for the review UI. */
export const getSummaryReview = async (meetingId: string) => {
  const meeting = await loadMeeting(meetingId);
  const corrections = await correctionRepo.findByMeetingId(meetingId);
  const data = meeting.summary?.data;

  return {
    modeSetting: effectiveModeSetting(meeting.mode, corrections),
    summaryMode: isSummaryV2(data) ? data.mode : null,
    detectedMode: isSummaryV2(data) ? data.detectedMode : null,
    actionItems: meeting.actionItems,
  };
};

/**
 * Records the user's mode choice. Stored as a MEETING_MODE correction
 * because this track does not own meeting.repository; see
 * docs/decisions/w1-sum.md ("Requests for other tracks").
 */
export const setMode = async (meetingId: string, rawMode: unknown) => {
  const mode = normalizeModeSetting(rawMode);
  if (!mode) {
    throw BadRequest(
      "mode must be one of GENERAL, LECTURE, INTERVIEW, PROJECT, ONE_ON_ONE or AUTO"
    );
  }

  const meeting = await loadMeeting(meetingId);
  const current = effectiveModeSetting(
    meeting.mode,
    await correctionRepo.findByMeetingId(meetingId)
  );

  if (current !== mode) {
    await correctionRepo.record({
      meetingId,
      kind: CORRECTION_KIND.MODE,
      before: { mode: current },
      after: { mode },
    });
  }

  return { modeSetting: mode };
};

export interface ResummarizeOptions {
  /** Overrides (and records) the mode before running. */
  mode?: unknown;
  /** IANA zone for resolving deadlines; UTC if missing. */
  timezone?: string | null;
  /** Persists CLEAN labels; wired once segment.repository has a writer. */
  writeNoiseLabels?: (labels: NoiseLabelUpdate[]) => Promise<void>;
}

/**
 * Runs the v2 pipeline over the meeting's stored segments and saves the
 * summary and action items. Human-reviewed action items survive.
 */
export const resummarize = async (
  meetingId: string,
  options: ResummarizeOptions = {}
) => {
  if (options.mode !== undefined && options.mode !== null) {
    await setMode(meetingId, options.mode);
  }

  const meeting = await loadMeeting(meetingId);
  const corrections = await correctionRepo.findByMeetingId(meetingId);
  const modeSetting = effectiveModeSetting(meeting.mode, corrections);

  const segments = await segmentRepo.findByMeetingId(meetingId);
  if (!segments.length) {
    throw BadRequest(
      "This meeting has no transcript segments yet. Transcribe it first."
    );
  }

  const { summary, markdown } = await runSummaryPipeline(
    segments.map((segment) => ({
      idx: segment.idx,
      speaker: segment.speaker,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      noiseLabel: segment.noiseLabel,
    })),
    {
      modeSetting,
      meetingStart: meeting.startedAt ?? meeting.createdAt,
      timezone: options.timezone ?? null,
      writeNoiseLabels: options.writeNoiseLabels,
    }
  );

  const saved = await summaryRepo.upsert(
    meetingId,
    markdown,
    toJsonValueV2(summary),
    summary.sentiment.overall
  );

  const created = await actionItemRepo.replaceForMeeting(
    meetingId,
    toActionItemInputs(summary),
    reviewedActionItems(corrections)
  );

  log.info("Meeting re-summarized", {
    meetingId,
    mode: summary.mode,
    modeSetting,
    actionItems: created,
  });

  return {
    summary: saved,
    actionItems: await actionItemRepo.findByMeetingId(meetingId),
  };
};

export interface ActionItemEdit {
  task?: string;
  owner?: string | null;
  dueSpoken?: string | null;
  priority?: string;
}

/**
 * accept / edit / reject one action item, recorded as an ACTION_ITEM
 * correction with before/after (evidence keeps TranscriptSegment.idx).
 */
export const reviewActionItem = async (
  meetingId: string,
  itemId: string,
  action: unknown,
  changes: ActionItemEdit = {},
  timezone: string | null = null
) => {
  if (typeof action !== "string" || !(REVIEW_ACTIONS as readonly string[]).includes(action)) {
    throw BadRequest("action must be accept, edit or reject");
  }

  const item = await actionItemRepo.findById(itemId);
  if (!item || item.meetingId !== meetingId) {
    throw NotFound("Action item not found");
  }

  const before: Prisma.InputJsonObject = {
    task: item.task,
    owner: item.owner,
    dueSpoken: item.dueSpoken,
    dueDate: item.dueDate,
    priority: item.priority,
    confidence: item.confidence,
    evidence: (item.evidence ?? null) as Prisma.InputJsonValue | null,
  };

  if (action === "reject") {
    await actionItemRepo.deleteById(itemId);
    await correctionRepo.record({
      meetingId,
      kind: CORRECTION_KIND.ACTION_ITEM,
      targetId: itemId,
      before,
      after: { action: "reject" },
    });

    return { id: itemId, deleted: true as const };
  }

  let update: Parameters<typeof actionItemRepo.updateReviewed>[1] = {};

  if (action === "edit") {
    if (changes.task !== undefined && !changes.task.trim()) {
      throw BadRequest("task cannot be empty");
    }

    update = {
      ...(changes.task !== undefined ? { task: changes.task.trim() } : {}),
      ...(changes.owner !== undefined ? { owner: changes.owner?.trim() || null } : {}),
      ...(changes.priority !== undefined
        ? { priority: asPriority(changes.priority.toUpperCase()) }
        : {}),
    };

    if (changes.dueSpoken !== undefined) {
      const meeting = await loadMeeting(meetingId);
      const dueSpoken = changes.dueSpoken?.trim() || null;

      update.dueSpoken = dueSpoken;
      update.dueDate = resolveSpokenDate(dueSpoken, {
        meetingStart: meeting.startedAt ?? meeting.createdAt,
        timezone,
      });
    }
  }

  const updated = await actionItemRepo.updateReviewed(itemId, update);

  await correctionRepo.record({
    meetingId,
    kind: CORRECTION_KIND.ACTION_ITEM,
    targetId: itemId,
    before,
    after: { action, ...update },
  });

  return updated;
};
