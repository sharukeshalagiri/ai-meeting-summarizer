import { useMemo, useState, type FormEvent } from "react";
import { getErrorMessage } from "../api/api";
import { changePassword, saveSettings } from "../api/account";
import { useAuth } from "../lib/auth/authContext";
import type { Account, RetentionPolicy } from "../types/account";

const MODE_LABELS: Record<string, string> = {
  AUTO: "Decide automatically",
  GENERAL: "General",
  LECTURE: "Lecture",
  INTERVIEW: "Interview",
  PROJECT: "Project",
  ONE_ON_ONE: "1:1",
};

const RETENTION_LABELS: Record<RetentionPolicy, string> = {
  KEEP: "Keep recordings",
  AFTER_PROCESSING: "Delete each recording once it is processed",
  AFTER_DAYS: "Delete recordings after a number of days",
};

const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
};

/** Settings: how you appear, how meetings are processed, and what is kept. */
function Settings() {
  const { account } = useAuth();
  // Layout only renders pages once the account is known.
  return account ? <SettingsForm account={account} /> : null;
}

function SettingsForm({ account }: { account: Account }) {
  const { refresh } = useAuth();
  const zoneList = useMemo(() => zones(), []);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [form, setForm] = useState<Account>(account);
  const [glossary, setGlossary] = useState(account.glossary.join("\n"));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const set = <K extends keyof Account>(key: K, value: Account[K]) => setForm({ ...form, [key]: value });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await saveSettings({
        name: form.name,
        displayName: form.displayName?.trim() || null,
        timezone: form.timezone?.trim() || null,
        defaultMode: form.defaultMode,
        transcriptionProvider: form.transcriptionProvider || null,
        glossary: glossary.split(/[\n,]/).map((t) => t.trim()).filter(Boolean),
        audioRetention: form.audioRetention,
        audioRetentionDays: form.audioRetentionDays ?? null,
      });
      await refresh();
      setMessage({ ok: true, text: "Settings saved." });
    } catch (err) {
      setMessage({ ok: false, text: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page acct">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">{account.email}</p>
        </div>
      </header>

      <form className="acct-form" onSubmit={(event) => void save(event)}>
        <section className="card acct-form">
          <h2>You</h2>
          <div>
            <label htmlFor="name">Name</label>
            <input id="name" type="text" value={form.name} onChange={(e) => set("name", e.target.value)} required />
          </div>
          <div>
            <label htmlFor="displayName">Your label in transcripts</label>
            <input
              id="displayName"
              type="text"
              placeholder="You"
              value={form.displayName ?? ""}
              onChange={(e) => set("displayName", e.target.value)}
              maxLength={60}
            />
            <p className="muted tiny hint">Used for your own microphone in new recordings and in exports.</p>
          </div>
          <div>
            <label htmlFor="timezone">Time zone</label>
            <input
              id="timezone"
              type="text"
              list="timezones"
              placeholder="UTC"
              value={form.timezone ?? ""}
              onChange={(e) => set("timezone", e.target.value)}
            />
            <datalist id="timezones">
              {zoneList.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="muted tiny hint">
              Spoken dates ("next Friday") are resolved in this zone.{" "}
              {browserZone && form.timezone !== browserZone && (
                <button type="button" className="secondary sm" onClick={() => set("timezone", browserZone)}>
                  Use {browserZone}
                </button>
              )}
            </p>
          </div>
        </section>

        <section className="card acct-form">
          <h2>Processing</h2>
          <div>
            <label htmlFor="defaultMode">Default meeting mode</label>
            <select id="defaultMode" value={form.defaultMode} onChange={(e) => set("defaultMode", e.target.value)}>
              {account.options.modes.map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABELS[mode] ?? mode}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="provider">Transcription</label>
            <select
              id="provider"
              value={form.transcriptionProvider ?? ""}
              onChange={(e) => set("transcriptionProvider", e.target.value || null)}
            >
              <option value="">Server default ({account.options.serverTranscriptionProvider})</option>
              {account.options.transcriptionProviders.map((provider) => (
                <option key={provider} value={provider}>
                  {provider === "local" ? "Local (Whisper on this server, free)" : "Deepgram (paid per audio minute)"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="glossary">Personal glossary</label>
            <textarea
              id="glossary"
              placeholder={"One term per line, e.g.\nKubernetes\nPriya Raman"}
              value={glossary}
              onChange={(e) => setGlossary(e.target.value)}
            />
            <p className="muted tiny hint">Names and jargon passed to transcription as hints, in every meeting.</p>
          </div>
        </section>

        <section className="card acct-form">
          <h2>Recordings</h2>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">Audio retention</legend>
            {account.options.retentionPolicies.map((policy) => (
              <label key={policy} className="acct-row" style={{ fontWeight: 400 }}>
                <input
                  type="radio"
                  name="retention"
                  value={policy}
                  checked={form.audioRetention === policy}
                  onChange={() => set("audioRetention", policy)}
                />
                {RETENTION_LABELS[policy]}
              </label>
            ))}
          </fieldset>
          {form.audioRetention === "AFTER_DAYS" && (
            <div>
              <label htmlFor="days">Days to keep</label>
              <input
                id="days"
                type="number"
                min={1}
                max={3650}
                value={form.audioRetentionDays ?? ""}
                onChange={(e) => set("audioRetentionDays", e.target.value ? Number(e.target.value) : null)}
                required
              />
            </div>
          )}
          <p className="muted tiny hint">
            Transcripts, summaries and tasks are always kept. Deletion runs on a schedule (hourly); a failed meeting keeps
            its recording so it can be retried.
          </p>
        </section>

        {message && (
          <div role={message.ok ? "status" : "alert"} className={message.ok ? "callout" : "alert"}>
            {message.text}
          </div>
        )}

        <div>
          <button type="submit" disabled={saving}>
            {saving ? <span className="spinner" /> : "Save settings"}
          </button>
        </div>
      </form>

      <PasswordForm />
    </div>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setMessage({ ok: true, text: "Password changed. Other browsers were signed out." });
    } catch (err) {
      setMessage({ ok: false, text: getErrorMessage(err) });
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="card acct-form" style={{ marginTop: 16 }} onSubmit={(event) => void submit(event)}>
      <h2>Password</h2>
      <div>
        <label htmlFor="current-password">Current password</label>
        <input id="current-password" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
      </div>
      <div>
        <label htmlFor="new-password">New password</label>
        <input id="new-password" type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" />
      </div>
      {message && (
        <div role={message.ok ? "status" : "alert"} className={message.ok ? "callout" : "alert"}>
          {message.text}
        </div>
      )}
      <div>
        <button type="submit" className="secondary" disabled={pending}>
          Change password
        </button>
      </div>
    </form>
  );
}

export default Settings;
