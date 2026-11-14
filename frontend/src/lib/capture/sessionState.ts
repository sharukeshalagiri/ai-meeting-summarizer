/**
 * Recorder session state for the extension's service worker
 * (chrome.storage.local: the current `session` and `pendingEnds`).
 *
 * Every write is a read-modify-write done inside one serialized section,
 * so a slow writer can never save a stale copy over a newer one. The
 * bug this prevents: a progress update reads the session, Stop clears
 * it, then the update writes the old copy back (a resurrected
 * "recording"); or the drain reads pendingEnds, Stop adds a session,
 * then the drain saves its old list and that session's /end is never
 * sent.
 *
 * Rules:
 * - `stopping` only goes false -> true; patches cannot clear it, and a
 *   stopping session accepts no more patches.
 * - pendingEnds is only changed by add/remove of specific ids, never by
 *   saving a whole list read earlier.
 *
 * The lock is in memory: all writers of these keys live in the service
 * worker (the offscreen document has no chrome.storage; the popup only
 * reads through the worker). A worker restart drops the lock, but also
 * every operation that held it.
 */

export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface RecorderSession {
  sessionId: string;
  meetingId: string;
  /** Set once by Stop; never cleared. */
  stopping?: boolean;
  [field: string]: unknown;
}

const SESSION_KEY = "session";
const PENDING_KEY = "pendingEnds";

/** Fields a progress patch may never change. */
const PROTECTED = new Set(["sessionId", "meetingId", "stopping"]);

export class SessionState {
  private storage: KeyValueStorage;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: KeyValueStorage) {
    this.storage = storage;
  }

  /** Runs `fn` after every earlier operation has finished. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);

    this.chain = run.catch(() => undefined);

    return run;
  }

  private async readSession(): Promise<RecorderSession | null> {
    return ((await this.storage.get(SESSION_KEY)) as RecorderSession | undefined) ?? null;
  }

  private async readPending(): Promise<string[]> {
    return ((await this.storage.get(PENDING_KEY)) as string[] | undefined) ?? [];
  }

  getSession(): Promise<RecorderSession | null> {
    return this.locked(() => this.readSession());
  }

  getPendingEnds(): Promise<string[]> {
    return this.locked(() => this.readPending());
  }

  /** Stores a new session; fails if one is already stored (two Starts racing). */
  startSession(session: RecorderSession): Promise<void> {
    return this.locked(async () => {
      if (await this.readSession()) {
        throw new Error("Already recording. Stop the current recording first.");
      }

      await this.storage.set(SESSION_KEY, { ...session, stopping: false });
    });
  }

  /**
   * Merges `patch` into the stored session if it is still `sessionId`
   * and not stopping. Returns false when the patch was dropped.
   */
  patchSession(sessionId: string, patch: Record<string, unknown>): Promise<boolean> {
    return this.locked(async () => {
      const current = await this.readSession();

      if (!current || current.sessionId !== sessionId || current.stopping) return false;

      const safe = Object.fromEntries(
        Object.entries(patch).filter(([key]) => !PROTECTED.has(key))
      );

      await this.storage.set(SESSION_KEY, { ...current, ...safe });

      return true;
    });
  }

  /** Marks the session stopping (false -> true only) and returns it; null if none. */
  markStopping(): Promise<RecorderSession | null> {
    return this.locked(async () => {
      const current = await this.readSession();

      if (!current) return null;

      const stopped = { ...current, stopping: true };

      await this.storage.set(SESSION_KEY, stopped);

      return stopped;
    });
  }

  /** Removes the stored session, but only if it is still `sessionId`. */
  clearSession(sessionId: string): Promise<void> {
    return this.locked(async () => {
      const current = await this.readSession();

      if (current?.sessionId === sessionId) await this.storage.remove(SESSION_KEY);
    });
  }

  addPendingEnd(sessionId: string): Promise<void> {
    return this.locked(async () => {
      const pending = await this.readPending();

      if (!pending.includes(sessionId)) {
        await this.storage.set(PENDING_KEY, [...pending, sessionId]);
      }
    });
  }

  /** Removes exactly these ids; ids added meanwhile survive. */
  removePendingEnds(sessionIds: Iterable<string>): Promise<string[]> {
    const drop = new Set(sessionIds);

    return this.locked(async () => {
      const pending = (await this.readPending()).filter((id) => !drop.has(id));

      await this.storage.set(PENDING_KEY, pending);

      return pending;
    });
  }
}

/** Adapter for chrome.storage.local (or any area with the same API). */
export const chromeStorageArea = (area: {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}): KeyValueStorage => ({
  get: async (key) => (await area.get(key))[key],
  set: (key, value) => area.set({ [key]: value }),
  remove: (key) => area.remove(key),
});
