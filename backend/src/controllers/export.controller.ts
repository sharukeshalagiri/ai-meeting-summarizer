import type { Request, Response } from "express";
import * as exportService from "../services/export/export.service";
import { sendSuccess } from "../types/api";
import { BadRequest } from "../types/errors";
import { asyncHandler } from "../utils/asyncHandler";
import { requireParam } from "../utils/validate";

const wantsTranscript = (value: unknown) => value === "1" || value === "true" || value === true;

/** RFC 6266 filename*, so non-ASCII titles survive the download. */
const attachment = (fileName: string) =>
  `attachment; filename="${fileName.replace(/[^\x20-\x7E]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

/**
 * GET /meetings/:id/export?format=md|pdf|json&transcript=1
 * - md: a Markdown file download
 * - pdf: a PDF download
 * - json: { markdown, fileName } for "copy as Markdown"
 */
export const exportMeeting = asyncHandler(async (req: Request, res: Response) => {
  const meetingId = requireParam(req.params.id, "meeting id");
  const format = typeof req.query.format === "string" ? req.query.format : "json";
  const transcript = wantsTranscript(req.query.transcript);

  if (format === "pdf") {
    const { pdf, fileName } = await exportService.exportPdf(meetingId, transcript);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": attachment(fileName) });
    return res.send(pdf);
  }

  if (format !== "md" && format !== "json") throw BadRequest("format must be md, pdf or json");

  const result = await exportService.exportMarkdown(meetingId, transcript);

  if (format === "md") {
    res.set({ "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": attachment(result.fileName) });
    return res.send(result.markdown);
  }

  return sendSuccess(res, result, "Export ready");
});

/** POST /meetings/:id/export/email { to?: string | string[], transcript?: boolean } */
export const emailMeeting = asyncHandler(async (req: Request, res: Response) =>
  sendSuccess(
    res,
    await exportService.emailExport({
      meetingId: requireParam(req.params.id, "meeting id"),
      to: req.body?.to,
      includeTranscript: wantsTranscript(req.body?.transcript),
    }),
    "Email sent"
  )
);
