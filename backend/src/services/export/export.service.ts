import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import * as correctionRepo from "../../repositories/correction.repository";
import * as exportRepo from "../../repositories/export.repository";
import * as segmentRepo from "../../repositories/segment.repository";
import { BadRequest, NotFound, UpstreamError } from "../../types/errors";
import { withSpeakerNames } from "../speakers/speakers.service";
import { reviewedActionItems } from "../summaryPipeline.service";
import { buildExport, type ExportDocument } from "./exportModel";
import { getTransport } from "./mailer";
import { fileNameFor, toMarkdown, toPdf } from "./render";

const log = logger.child({ module: "export.service" });

/**
 * Exports of one meeting: Markdown (copy or file), PDF, and email.
 * The meeting's ownership was checked by the /meetings/:id guard; the
 * owner is loaded here for names, timezone and the email address.
 */

export const loadExport = async (
  meetingId: string,
  options: { includeTranscript: boolean }
): Promise<{ doc: ExportDocument; date: Date; owner: { email: string; name: string } }> => {
  const meeting = await exportRepo.findForExport(meetingId);
  if (!meeting) throw NotFound("Meeting not found");

  const [corrections, segments, named] = await Promise.all([
    correctionRepo.findByMeetingId(meetingId),
    options.includeTranscript ? segmentRepo.findByMeetingId(meetingId) : Promise.resolve([]),
    // Speaker renames, projected at read time like the meeting page.
    withSpeakerNames({ id: meetingId, summary: meeting.summary, actionItems: meeting.actionItems }),
  ]);

  const doc = buildExport({
    meeting: {
      title: meeting.title,
      createdAt: meeting.createdAt,
      startedAt: meeting.startedAt,
      durationSec: meeting.durationSec,
      mode: meeting.mode,
      seriesName: meeting.series?.name ?? null,
    },
    summaryData: named.summary?.data ?? null,
    actionItems: named.actionItems,
    rejectedTasks: reviewedActionItems(corrections).suppressTasks,
    segments,
    meLabel: meeting.user.displayName?.trim() || env.meDisplayName,
    defaultMeLabel: env.meDisplayName,
    timezone: meeting.user.timezone,
    includeTranscript: options.includeTranscript,
  });

  return {
    doc,
    date: meeting.startedAt ?? meeting.createdAt,
    owner: { email: meeting.user.email, name: meeting.user.name },
  };
};

export const exportMarkdown = async (meetingId: string, includeTranscript: boolean) => {
  const { doc, date } = await loadExport(meetingId, { includeTranscript });
  return { markdown: toMarkdown(doc), fileName: fileNameFor(doc, date, "md") };
};

export const exportPdf = async (meetingId: string, includeTranscript: boolean) => {
  const { doc, date } = await loadExport(meetingId, { includeTranscript });
  return { pdf: await toPdf(doc), fileName: fileNameFor(doc, date, "pdf") };
};

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
export const MAX_RECIPIENTS = 10;

/** Recipients default to the owner's own address. */
export const parseRecipients = (value: unknown, fallback: string): string[] => {
  if (value === undefined || value === null || value === "") return [fallback];

  const list = (Array.isArray(value) ? value : String(value).split(/[,;\s]+/))
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  if (list.length === 0) return [fallback];
  if (list.length > MAX_RECIPIENTS) throw BadRequest(`At most ${MAX_RECIPIENTS} recipients.`);

  for (const address of list) {
    if (!EMAIL.test(address)) throw BadRequest(`Not an email address: ${address.slice(0, 80)}`);
  }
  return [...new Set(list.map((a) => a.toLowerCase()))];
};

/**
 * Sends the summary as Markdown text with the PDF attached. Uses the
 * configured SMTP transport only (mailer.ts); never logs the content.
 */
export const emailExport = async (input: {
  meetingId: string;
  to: unknown;
  includeTranscript: boolean;
}) => {
  const { doc, date, owner } = await loadExport(input.meetingId, {
    includeTranscript: input.includeTranscript,
  });
  const recipients = parseRecipients(input.to, owner.email);
  const transport = getTransport();
  const markdown = toMarkdown(doc);

  try {
    const info = await transport.sendMail({
      from: env.smtpFrom,
      to: recipients,
      replyTo: owner.email,
      subject: `Meeting notes: ${doc.title}`,
      text: markdown,
      attachments: [
        { filename: fileNameFor(doc, date, "pdf"), content: await toPdf(doc), contentType: "application/pdf" },
        { filename: fileNameFor(doc, date, "md"), content: markdown, contentType: "text/markdown" },
      ],
    });

    log.info("Summary emailed", { meetingId: input.meetingId, recipients: recipients.length });

    return { sent: true, recipients, messageId: (info as { messageId?: string }).messageId ?? null };
  } catch (error) {
    log.error("Sending the summary email failed", error, { meetingId: input.meetingId });
    throw UpstreamError("The email could not be sent. Check the SMTP settings and try again.");
  }
};
