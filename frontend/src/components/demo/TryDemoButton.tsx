import { useEffect, useState } from "react";
import { getErrorMessage } from "../../api/api";
import { getDemoStatus, startDemo } from "../../api/demo";
import "./demo.css";

interface Props {
  /** Called once signed in, with the meeting to open (or null). */
  onSignedIn: (meetingId: string | null) => Promise<void> | void;
}

/**
 * "Try the demo": shown only when the server runs with DEMO_MODE. One
 * click signs into the read-only demo account, no sign-up.
 */
export function TryDemoButton({ onSignedIn }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getDemoStatus()
      .then((status) => live && setEnabled(status.enabled))
      .catch(() => live && setEnabled(false));
    return () => {
      live = false;
    };
  }, []);

  if (!enabled) return null;

  const start = async () => {
    setError(null);
    setPending(true);
    try {
      const { meetingId } = await startDemo();
      await onSignedIn(meetingId);
    } catch (err) {
      setError(getErrorMessage(err));
      setPending(false);
    }
  };

  return (
    <div className="demo-cta">
      <button type="button" className="demo-button" onClick={() => void start()} disabled={pending}>
        {pending ? <span className="spinner" /> : "Try the demo"}
      </button>
      <p className="muted tiny">
        No sign-up. Three synthetic meetings (a lecture, an interview, a project sync), read-only.
      </p>
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
    </div>
  );
}
