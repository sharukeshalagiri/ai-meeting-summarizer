import PDFDocument from "pdfkit";
import type { ExportDocument } from "./exportModel";

/**
 * Markdown and PDF from one ExportDocument.
 *
 * The PDF is drawn with pdfkit (pure JavaScript, no headless browser),
 * using its built-in Helvetica, which only covers Latin-1. Characters
 * outside it are replaced rather than drawn as boxes; the Markdown
 * export keeps the text exactly.
 */

/** Markdown special characters in model text would turn into markup. */
const escapeMd = (text: string) => text.replace(/([\\`*_[\]<>#|])/g, "\\$1");

const metaSuffix = (meta: string[]) => (meta.length ? ` _(${meta.map(escapeMd).join("; ")})_` : "");

export const toMarkdown = (doc: ExportDocument): string => {
  const lines: string[] = [`# ${escapeMd(doc.title)}`, "", `_${escapeMd(doc.subtitle)}_`];

  if (doc.series) lines.push("", `Series: ${escapeMd(doc.series)}`);
  if (doc.tldr) lines.push("", "## Summary", "", escapeMd(doc.tldr));

  for (const section of doc.sections) {
    lines.push("", `## ${escapeMd(section.heading)}`, "");
    for (const item of section.items) lines.push(`- ${escapeMd(item.text)}${metaSuffix(item.meta)}`);
  }

  if (doc.transcript?.length) {
    lines.push("", "## Transcript", "");
    for (const line of doc.transcript) {
      lines.push(`**[${line.at}] ${escapeMd(line.speaker)}:** ${escapeMd(line.text)}  `);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

/** Typographic punctuation to ASCII, the rest of non-Latin-1 to "?". */
export const toLatin1 = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");

export const toPdf = (doc: ExportDocument): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 56,
      info: { Title: toLatin1(doc.title), Creator: "Meeting Companion" },
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const text = (value: string) => toLatin1(value);

    pdf.font("Helvetica-Bold").fontSize(18).text(text(doc.title));
    pdf.moveDown(0.2).font("Helvetica").fontSize(10).fillColor("#555555").text(text(doc.subtitle));
    if (doc.series) pdf.text(text(`Series: ${doc.series}`));
    pdf.fillColor("#000000");

    if (doc.tldr) {
      pdf.moveDown().font("Helvetica-Bold").fontSize(13).text("Summary");
      pdf.moveDown(0.3).font("Helvetica").fontSize(10.5).text(text(doc.tldr));
    }

    for (const section of doc.sections) {
      pdf.moveDown().font("Helvetica-Bold").fontSize(13).text(text(section.heading));
      pdf.moveDown(0.3).font("Helvetica").fontSize(10.5);
      for (const item of section.items) {
        pdf.text(text(`- ${item.text}`), { indent: 0, continued: item.meta.length > 0 });
        if (item.meta.length) {
          pdf.fillColor("#555555").text(text(`  (${item.meta.join("; ")})`)).fillColor("#000000");
        }
        pdf.moveDown(0.15);
      }
    }

    if (doc.transcript?.length) {
      pdf.addPage().font("Helvetica-Bold").fontSize(13).text("Transcript");
      pdf.moveDown(0.3).fontSize(9.5);
      for (const line of doc.transcript) {
        pdf.font("Helvetica-Bold").text(text(`[${line.at}] ${line.speaker}: `), { continued: true });
        pdf.font("Helvetica").text(text(line.text));
      }
    }

    pdf.end();
  });

/** A file name from the title: "Weekly sync 2026-11-14.md". */
export const fileNameFor = (doc: { title: string }, date: Date, extension: "md" | "pdf") => {
  const base =
    doc.title
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80) || "meeting";
  return `${base} ${date.toISOString().slice(0, 10)}.${extension}`;
};
