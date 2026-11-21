import { useState } from "react";
import { getErrorMessage } from "../../api/api";
import { downloadExport, emailExport, exportMarkdown } from "../../api/account";
import { useAuth } from "../../lib/auth/authContext";

/**
 * Export a meeting: copy as Markdown, a Markdown file, a PDF, or email
 * (when the server has SMTP set up). Exports use people's names, and
 * leave out small talk and anything rejected in review.
 */
function ExportMenu({ meetingId }: { meetingId: string }) {
  const { account } = useAuth();
  const [transcript, setTranscript] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus({ ok: true, text: await work() });
    } catch (err) {
      setStatus({ ok: false, text: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const copy = () =>
    run(async () => {
      const { markdown } = await exportMarkdown(meetingId, transcript);
      await navigator.clipboard.writeText(markdown);
      return "Copied as Markdown.";
    });

  const emailEnabled = account?.options.emailEnabled ?? false;

  return (
    <details className="card acct">
      <summary>Export</summary>
      <div className="stack" style={{ marginTop: 12 }}>
        <label className="acct-row" style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={transcript} onChange={(e) => setTranscript(e.target.checked)} />
          Include the transcript (without small talk)
        </label>
        <div className="export-menu">
          <button type="button" className="secondary sm" disabled={busy} onClick={() => void copy()}>
            Copy as Markdown
          </button>
          <button
            type="button"
            className="secondary sm"
            disabled={busy}
            onClick={() => void run(async () => (await downloadExport(meetingId, "md", transcript), "Markdown file downloaded."))}
          >
            Markdown file
          </button>
          <button
            type="button"
            className="secondary sm"
            disabled={busy}
            onClick={() => void run(async () => (await downloadExport(meetingId, "pdf", transcript), "PDF downloaded."))}
          >
            PDF
          </button>
          <button
            type="button"
            className="secondary sm"
            disabled={busy || !emailEnabled}
            title={emailEnabled ? undefined : "Email is not set up on this server (SMTP)"}
            onClick={() => setEmailOpen((open) => !open)}
          >
            Email
          </button>
        </div>

        {emailOpen && emailEnabled && (
          <form
            className="acct-row"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await emailExport(meetingId, to, transcript);
                setEmailOpen(false);
                return `Sent to ${result.recipients.join(", ")}.`;
              });
            }}
          >
            <input
              type="email"
              multiple
              aria-label="Recipients"
              placeholder={account?.email ?? "me@example.com"}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              style={{ flex: "1 1 240px" }}
            />
            <button type="submit" className="sm" disabled={busy}>
              Send
            </button>
          </form>
        )}

        {status && (
          <p role={status.ok ? "status" : "alert"} className="tiny" style={{ margin: 0, color: status.ok ? "var(--ok)" : "var(--danger)" }}>
            {status.text}
          </p>
        )}
      </div>
    </details>
  );
}

export default ExportMenu;
