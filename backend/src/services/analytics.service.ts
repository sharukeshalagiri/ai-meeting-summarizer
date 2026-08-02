import * as actionItemRepo from "../repositories/actionItem.repository";
import * as meetingRepo from "../repositories/meeting.repository";
import { parseStructuredSummary } from "./summary.service";
import type { StructuredSummary } from "../types/summary";

/**
 * Dashboard analytics.
 *
 * Counts and sums are aggregated in PostgreSQL; trends over the
 * structured summary JSON are computed here, because they need the
 * same parsing rules the rest of the app uses to read a stored
 * summary, including the tolerance for rows written before the schema
 * grew.
 */

/** A row in one of the trend lists. */
export interface TrendEntry {
  label: string;
  count: number;
}

export interface DailyPoint {
  date: string;
  meetings: number;
  durationMin: number;
}

const startOfDay = (date: Date): Date => {
  const copy = new Date(date);

  copy.setHours(0, 0, 0, 0);

  return copy;
};

const isoDate = (date: Date): string =>
  date.toISOString().slice(0, 10);

/**
 * Counts occurrences and returns the most frequent, largest first.
 *
 * Labels are compared case-insensitively so "Kubernetes" and
 * "kubernetes" do not split a trend in two, while the first-seen
 * casing is what gets displayed.
 */
const topBy = (values: string[], limit: number): TrendEntry[] => {
  const counts = new Map<string, { label: string; count: number }>();

  for (const value of values) {
    const key = value.trim().toLowerCase();

    if (!key) continue;

    const existing = counts.get(key);

    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { label: value.trim(), count: 1 });
    }
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
};

/**
 * Reads a stored summary's JSON.
 *
 * Returns null rather than throwing: one unreadable row should not
 * take down the whole dashboard.
 */
const readSummary = (data: unknown): StructuredSummary | null => {
  if (typeof data !== "object" || data === null) return null;

  try {
    return parseStructuredSummary(data as Record<string, unknown>);
  } catch {
    return null;
  }
};

/** Meetings per day over the window, including days with none. */
const buildDailySeries = (
  meetings: { createdAt: Date; durationSec: number | null }[],
  days: number
): DailyPoint[] => {
  const buckets = new Map<string, DailyPoint>();

  const today = startOfDay(new Date());

  // Seed every day so the chart shows gaps rather than skipping them,
  // which would distort the spacing of the line.
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(today);

    day.setDate(day.getDate() - offset);

    buckets.set(isoDate(day), {
      date: isoDate(day),
      meetings: 0,
      durationMin: 0,
    });
  }

  for (const meeting of meetings) {
    const key = isoDate(startOfDay(meeting.createdAt));

    const bucket = buckets.get(key);

    if (!bucket) continue;

    bucket.meetings += 1;
    bucket.durationMin += Math.round((meeting.durationSec ?? 0) / 60);
  }

  return [...buckets.values()];
};

export const getOverview = async (days = 30) => {
  const since = startOfDay(new Date());

  since.setDate(since.getDate() - (days - 1));

  const [
    meetingStats,
    byStatus,
    bySource,
    recent,
    summaries,
    actionCounts,
    totalActions,
    byOwner,
  ] = await Promise.all([
    meetingRepo.stats(),
    meetingRepo.countByStatus(),
    meetingRepo.countBySource(),
    meetingRepo.findSince(since),
    meetingRepo.findSummaryData(),
    actionItemRepo.countByStatus(),
    actionItemRepo.countAll(),
    actionItemRepo.countOpenByOwner(),
  ]);

  const parsed = summaries
    .map((row) => ({ row, summary: readSummary(row.data) }))
    .filter(
      (entry): entry is { row: (typeof summaries)[number]; summary: StructuredSummary } =>
        entry.summary !== null
    );

  const completed =
    actionCounts.find((entry) => entry.status === "COMPLETED")?._count
      ._all ?? 0;

  const pending =
    actionCounts.find((entry) => entry.status === "PENDING")?._count
      ._all ?? 0;

  const totalDurationSec = meetingStats._sum.durationSec ?? 0;
  const avgDurationSec = Math.round(meetingStats._avg.durationSec ?? 0);

  // Sentiment is read from the lifted column where present and from
  // the JSON otherwise, so meetings summarized before the column
  // existed still count.
  const sentimentCounts = parsed.reduce<Record<string, number>>(
    (acc, entry) => {
      const value =
        entry.row.sentiment ?? entry.summary.sentiment.overall;

      acc[value] = (acc[value] ?? 0) + 1;

      return acc;
    },
    {}
  );

  return {
    totals: {
      meetings: meetingStats._count._all,
      totalDurationSec,
      totalDurationMin: Math.round(totalDurationSec / 60),
      avgDurationSec,
      avgDurationMin: Math.round(avgDurationSec / 60),

      actionItems: totalActions,
      completedActionItems: completed,
      pendingActionItems: pending,
      completionRate:
        totalActions > 0
          ? Math.round((completed / totalActions) * 100)
          : 0,

      decisions: parsed.reduce(
        (sum, entry) => sum + entry.summary.keyDecisions.length,
        0
      ),
      risks: parsed.reduce(
        (sum, entry) => sum + entry.summary.risks.length,
        0
      ),
      blockers: parsed.reduce(
        (sum, entry) => sum + entry.summary.blockers.length,
        0
      ),
      openQuestions: parsed.reduce(
        (sum, entry) => sum + entry.summary.openQuestions.length,
        0
      ),
    },

    meetingsByStatus: byStatus.map((entry) => ({
      label: entry.status,
      count: entry._count._all,
    })),

    meetingsBySource: bySource.map((entry) => ({
      label: entry.source,
      count: entry._count._all,
    })),

    frequency: buildDailySeries(recent, days),

    keywordTrends: topBy(
      parsed.flatMap((entry) => entry.summary.keywords),
      12
    ),

    topicTrends: topBy(
      parsed.flatMap((entry) =>
        entry.summary.discussionTopics.map((topic) => topic.topic)
      ),
      10
    ),

    sentimentBreakdown: ["POSITIVE", "NEUTRAL", "MIXED", "NEGATIVE"]
      .map((label) => ({ label, count: sentimentCounts[label] ?? 0 }))
      .filter((entry) => entry.count > 0),

    /** Sentiment per meeting over time, for the trend line. */
    sentimentTimeline: parsed.map((entry) => ({
      date: isoDate(entry.row.meeting.createdAt),
      meetingId: entry.row.meetingId,
      title: entry.row.meeting.title,
      sentiment: entry.row.sentiment ?? entry.summary.sentiment.overall,
    })),

    workload: byOwner.map((entry) => ({
      label: entry.owner ?? "Unassigned",
      count: entry._count._all,
    })),
  };
};
