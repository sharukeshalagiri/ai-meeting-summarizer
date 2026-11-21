import { DEMO_EMAIL } from "../../api/demo";
import "./demo.css";

/**
 * A strip under the header while signed in to the demo account, so a
 * refused edit is not a surprise. The server enforces read-only either
 * way; this is only the explanation. Rendered by Layout under the header.
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
