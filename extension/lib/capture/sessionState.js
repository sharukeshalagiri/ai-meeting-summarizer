// GENERATED from frontend/src/lib/capture/sessionState.ts by
// extension/scripts/build-capture.mjs. Do not edit; edit the source.
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
const SESSION_KEY = "session";
const PENDING_KEY = "pendingEnds";
/** Fields a progress patch may never change. */
const PROTECTED = new Set(["sessionId", "meetingId", "stopping"]);
export class SessionState {
    storage;
    chain = Promise.resolve();
    constructor(storage) {
        this.storage = storage;
    }
    /** Runs `fn` after every earlier operation has finished. */
    locked(fn) {
        const run = this.chain.then(fn);
        this.chain = run.catch(() => undefined);
        return run;
    }
    async readSession() {
        return (await this.storage.get(SESSION_KEY)) ?? null;
    }
    async readPending() {
        return (await this.storage.get(PENDING_KEY)) ?? [];
    }
    getSession() {
        return this.locked(() => this.readSession());
    }
    getPendingEnds() {
        return this.locked(() => this.readPending());
    }
    /** Stores a new session; fails if one is already stored (two Starts racing). */
    startSession(session) {
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
    patchSession(sessionId, patch) {
        return this.locked(async () => {
            const current = await this.readSession();
            if (!current || current.sessionId !== sessionId || current.stopping)
                return false;
            const safe = Object.fromEntries(Object.entries(patch).filter(([key]) => !PROTECTED.has(key)));
            await this.storage.set(SESSION_KEY, { ...current, ...safe });
            return true;
        });
    }
    /** Marks the session stopping (false -> true only) and returns it; null if none. */
    markStopping() {
        return this.locked(async () => {
            const current = await this.readSession();
            if (!current)
                return null;
            const stopped = { ...current, stopping: true };
            await this.storage.set(SESSION_KEY, stopped);
            return stopped;
        });
    }
    /** Removes the stored session, but only if it is still `sessionId`. */
    clearSession(sessionId) {
        return this.locked(async () => {
            const current = await this.readSession();
            if (current?.sessionId === sessionId)
                await this.storage.remove(SESSION_KEY);
        });
    }
    addPendingEnd(sessionId) {
        return this.locked(async () => {
            const pending = await this.readPending();
            if (!pending.includes(sessionId)) {
                await this.storage.set(PENDING_KEY, [...pending, sessionId]);
            }
        });
    }
    /** Removes exactly these ids; ids added meanwhile survive. */
    removePendingEnds(sessionIds) {
        const drop = new Set(sessionIds);
        return this.locked(async () => {
            const pending = (await this.readPending()).filter((id) => !drop.has(id));
            await this.storage.set(PENDING_KEY, pending);
            return pending;
        });
    }
}
/** Adapter for chrome.storage.local (or any area with the same API). */
export const chromeStorageArea = (area) => ({
    get: async (key) => (await area.get(key))[key],
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
});
