import { DEMO_EMAIL } from "../../api/w5-demo";
import "./demo.css";

/**
 * A strip under the header while signed in to the demo account, so a
 * refused edit is not a surprise. The server enforces read-only either
 * way; this is only the explanation. Meant for Layout (w4-acct's file),
 * which renders it once the integrator adds it:
 * `<DemoBanner email={account.email} />`.
 */
export function DemoBanner({ email }: { email: string | null | undefined }) {
  if (email?.toLowerCase() !== DEMO_EMAIL) return null;

  return (
    <div className="demo-banner" role="note">
      <strong>Demo, read-only.</strong> Three synthetic meetings: open a summary and click any chip to hear the
      moment it came from. Uploads, edits and AI calls are off here.
    </div>
  );
}
