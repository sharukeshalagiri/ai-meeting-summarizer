import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { getErrorMessage } from "../api/api";
import { login, signup } from "../api/account";
import { TryDemoButton } from "../components/demo/TryDemoButton";
import { useAuth } from "../lib/auth/authContext";

/** Only same-app paths, so ?next= cannot send the user to another site. */
const safeNext = (value: string | null) =>
  value && value.startsWith("/") && !value.startsWith("//") ? value : "/";

/** Sign in with email and password (and sign up, when the server allows it). */
function Login() {
  const { account, signupEnabled, refresh } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where "Try the demo" lands (the newest demo meeting).
  const [demoTarget, setDemoTarget] = useState<string | null>(null);

  if (account) return <Navigate to={demoTarget ?? next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (mode === "signup") await signup(name, email, password);
      else await login(email, password);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="login-wrap acct">
      <div className="card login-card">
        <h1>{mode === "signup" ? "Create your account" : "Sign in"}</h1>
        <p className="muted">Your meetings, transcripts and tasks are private to your account.</p>

        <TryDemoButton
          onSignedIn={async (meetingId) => {
            setDemoTarget(meetingId ? `/meeting/${meetingId}` : "/");
            await refresh();
          }}
        />

        <form className="acct-form" onSubmit={(event) => void submit(event)}>
          {mode === "signup" && (
            <div>
              <label htmlFor="name">Name</label>
              <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </div>
          )}
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "signup" ? 10 : undefined}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
            {mode === "signup" && <p className="muted tiny hint">At least 10 characters.</p>}
          </div>

          {error && (
            <div role="alert" className="alert">
              {error}
            </div>
          )}

          <button type="submit" disabled={pending}>
            {pending ? <span className="spinner" /> : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>

        {signupEnabled && (
          <p className="muted tiny">
            {mode === "signin" ? "No account yet? " : "Already have one? "}
            <button
              type="button"
              className="secondary sm"
              onClick={() => {
                setError(null);
                setMode(mode === "signin" ? "signup" : "signin");
              }}
            >
              {mode === "signin" ? "Create one" : "Sign in"}
            </button>
          </p>
        )}
        {!signupEnabled && (
          <p className="muted tiny">
            Accounts are created by the server owner (npm --prefix backend run user:password).
          </p>
        )}
      </div>
    </div>
  );
}

export default Login;
