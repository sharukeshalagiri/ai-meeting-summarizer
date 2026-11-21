import { useState, type FormEvent } from "react";
import { API_BASE_URL, getErrorMessage } from "../api/api";
import { createDevice, revokeDevice } from "../api/account";
import ErrorState from "../components/ErrorState";
import { Skeleton } from "../components/Skeleton";
import { useFetch } from "../hooks/useFetch";
import type { Device, DeviceKind } from "../types/account";
import { formatDate } from "../utils/format";

const KIND_LABELS: Record<DeviceKind, string> = {
  EXTENSION: "Chrome extension",
  DESKTOP: "Desktop recorder",
  OTHER: "Other",
};

const WHERE: Record<DeviceKind, string> = {
  EXTENSION: "Extension popup → Settings → Device token.",
  DESKTOP: "Desktop recorder tray menu → Settings → Device token.",
  OTHER: "Send it as: Authorization: Bearer <token>.",
};

/**
 * Devices: one token per recorder. A recorder sends its token on every
 * upload; revoking it stops that recorder at once and leaves the others
 * working. The token is shown only once, when it is created.
 */
function Devices() {
  const { data, loading, error, refetch, setData } = useFetch<Device[]>("/devices");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DeviceKind>("EXTENSION");
  const [created, setCreated] = useState<{ token: string; device: Device } | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setActionError(null);
    setPending(true);
    try {
      const result = await createDevice(name.trim() || KIND_LABELS[kind], kind);
      setCreated(result);
      setCopied(false);
      setName("");
      setData([result.device, ...(data ?? [])]);
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const revoke = async (device: Device) => {
    if (!window.confirm(`Revoke "${device.name}"? That recorder stops uploading until it gets a new token.`)) return;
    setActionError(null);
    try {
      const updated = await revokeDevice(device.id);
      setData((data ?? []).map((d) => (d.id === device.id ? { ...d, revokedAt: updated.revokedAt } : d)));
      if (created?.device.id === device.id) setCreated(null);
    } catch (err) {
      setActionError(getErrorMessage(err));
    }
  };

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="page acct">
      <header className="page-header">
        <div>
          <h1>Devices</h1>
          <p className="muted">Tokens for the Chrome extension and the desktop recorder.</p>
        </div>
      </header>

      <form className="card acct-form" onSubmit={(event) => void create(event)}>
        <h2>Add a device</h2>
        <div className="acct-row">
          <div style={{ flex: "1 1 200px" }}>
            <label htmlFor="device-name">Name</label>
            <input id="device-name" type="text" placeholder="Work laptop" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </div>
          <div style={{ flex: "1 1 180px" }}>
            <label htmlFor="device-kind">Recorder</label>
            <select id="device-kind" value={kind} onChange={(e) => setKind(e.target.value as DeviceKind)}>
              {(Object.keys(KIND_LABELS) as DeviceKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <button type="submit" disabled={pending}>
            Create token
          </button>
        </div>
      </form>

      {created && (
        <div className="card acct-form" role="status" style={{ marginTop: 16 }}>
          <h2>Copy this token now</h2>
          <p className="muted">It is shown only once. {WHERE[created.device.kind]}</p>
          <div className="token-box">{created.token}</div>
          <p className="muted tiny">
            Backend URL for the recorder: <code>{API_BASE_URL}</code>
          </p>
          <div className="acct-row">
            <button type="button" onClick={() => void copy(created.token)}>
              {copied ? "Copied" : "Copy token"}
            </button>
            <button type="button" className="secondary" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div role="alert" className="alert">
          {actionError}
        </div>
      )}

      <section style={{ marginTop: 16 }}>
        <h2>Your devices</h2>
        {loading && <Skeleton rows={2} />}
        {error && <ErrorState message={error} onRetry={() => void refetch()} />}
        {data && data.length === 0 && <p className="muted">No devices yet.</p>}
        {data && data.length > 0 && (
          <ul className="device-list">
            {data.map((device) => (
              <li key={device.id} className={`card device-row ${device.revokedAt ? "is-revoked" : ""}`}>
                <div>
                  <strong>{device.name}</strong>{" "}
                  <span className="chip">{KIND_LABELS[device.kind] ?? device.kind}</span>
                  <p className="muted tiny" style={{ margin: "4px 0 0" }}>
                    <code>{device.prefix}…</code> · created {formatDate(device.createdAt)} ·{" "}
                    {device.lastUsedAt ? `last used ${formatDate(device.lastUsedAt)}` : "never used"}
                    {device.revokedAt && ` · revoked ${formatDate(device.revokedAt)}`}
                  </p>
                </div>
                {!device.revokedAt && (
                  <button type="button" className="secondary sm" onClick={() => void revoke(device)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default Devices;
