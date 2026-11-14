// GENERATED from frontend/src/lib/capture/uploadQueue.ts by
// extension/scripts/build-capture.mjs. Do not edit; edit the source.
export class MemoryChunkStore {
    chunks = new Map();
    async put(chunk) {
        this.chunks.set(chunk.id, { ...chunk });
    }
    async delete(id) {
        this.chunks.delete(id);
    }
    async list() {
        return [...this.chunks.values()].map((chunk) => ({ ...chunk }));
    }
    async update(id, change) {
        const current = this.chunks.get(id);
        if (!current)
            return false;
        this.chunks.set(id, { ...change({ ...current }), id });
        return true;
    }
}
const DB_NAME = "meeting-capture";
const STORE_NAME = "chunks";
const requestToPromise = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});
/**
 * IndexedDB store. In the extension the popup, service worker and
 * offscreen document share one origin, so they all see the same queue
 * (the popup counts it; the worker drains what the offscreen left).
 */
export class IdbChunkStore {
    db = null;
    open() {
        if (!this.db) {
            this.db = new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return this.db;
    }
    async tx(mode, run) {
        const db = await this.open();
        const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
        return requestToPromise(run(store));
    }
    async put(chunk) {
        await this.tx("readwrite", (store) => store.put(chunk));
    }
    async delete(id) {
        await this.tx("readwrite", (store) => store.delete(id));
    }
    async list() {
        return (await this.tx("readonly", (store) => store.getAll()));
    }
    async update(id, change) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const read = store.get(id);
            let updated = false;
            // get and put share one readwrite transaction, so no other
            // context can write the record between them.
            read.onsuccess = () => {
                const current = read.result;
                if (!current)
                    return;
                store.put({ ...change(current), id });
                updated = true;
            };
            tx.oncomplete = () => resolve(updated);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
}
/** IndexedDB when the context has it, memory otherwise (private modes). */
export const createDefaultStore = () => typeof indexedDB === "undefined" ? new MemoryChunkStore() : new IdbChunkStore();
export const BACKOFF = { baseMs: 2_000, maxMs: 30_000 };
/** 2 s, 4 s, 8 s ... capped at 30 s (the contract's suggested schedule). */
export const backoffDelay = (attempts) => Math.min(BACKOFF.baseMs * 2 ** Math.max(0, attempts - 1), BACKOFF.maxMs);
/**
 * Uploads one chunk at a time in (sessionId, seq) order. Sequential on
 * purpose: chunks are 20 s apart and each is a Whisper + Gemini call,
 * so parallel uploads would only queue up on the server (and get 409s).
 */
export class UploadQueue {
    options;
    running = false;
    rerun = false;
    timer = null;
    halted = null;
    lastRetry = null;
    waiters = [];
    constructor(options) {
        this.options = options;
    }
    /** Persists the chunk first, then kicks the uploader. */
    async enqueue(chunk) {
        await this.options.store.put(chunk);
        this.kick();
    }
    /**
     * Starts (or resumes) uploading whatever is in the store. Call it on
     * startup, on the `online` event and after the token is fixed.
     */
    kick() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        void this.run();
    }
    /** Clears a 401 halt (e.g. after the token was changed) and resumes. */
    resume() {
        this.halted = null;
        this.kick();
    }
    /** Stops scheduling retries; stored chunks stay for the next run. */
    dispose() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.halted = this.halted ?? "disposed";
    }
    async state() {
        const all = await this.options.store.list();
        return {
            pending: all.filter((chunk) => !chunk.failed).length,
            failed: all.filter((chunk) => chunk.failed).length,
            halted: this.halted,
            lastRetry: this.lastRetry,
        };
    }
    /**
     * Resolves with the number of chunks of `sessionId` still waiting
     * once that number reaches 0, uploading halts, or `timeoutMs` passes.
     * Used on stop: end the session only after its audio is in.
     */
    async flush(sessionId, timeoutMs) {
        const remaining = async () => (await this.options.store.list()).filter((chunk) => chunk.sessionId === sessionId && !chunk.failed).length;
        const deadline = Date.now() + timeoutMs;
        this.kick();
        for (;;) {
            const left = await remaining();
            if (left === 0 || this.halted || Date.now() >= deadline)
                return left;
            await new Promise((resolve) => {
                const timeout = setTimeout(resolve, Math.max(0, deadline - Date.now()));
                this.waiters.push(() => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }
    }
    notify() {
        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach((wake) => wake());
        void this.state().then((state) => this.options.onState?.(state));
    }
    async run() {
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.running = true;
        try {
            do {
                this.rerun = false;
                await this.drain();
            } while (this.rerun && !this.halted);
        }
        finally {
            this.running = false;
            this.notify();
        }
    }
    async drain() {
        const { store, upload } = this.options;
        while (!this.halted) {
            const pending = (await store.list())
                .filter((chunk) => !chunk.failed)
                .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq);
            if (pending.length === 0)
                return;
            const now = Date.now();
            const due = pending.find((chunk) => chunk.nextAttemptAt <= now);
            if (!due) {
                const next = Math.min(...pending.map((chunk) => chunk.nextAttemptAt));
                if (this.timer)
                    clearTimeout(this.timer);
                this.timer = setTimeout(() => {
                    this.timer = null;
                    void this.run();
                }, next - now);
                return;
            }
            let outcome;
            try {
                outcome = await upload(due);
            }
            catch (error) {
                outcome = {
                    kind: "retry",
                    status: null,
                    reason: error instanceof Error ? error.message : "Upload failed",
                };
            }
            await this.apply(due, outcome);
            this.notify();
        }
    }
    async apply(chunk, outcome) {
        const { store } = this.options;
        switch (outcome.kind) {
            case "done":
                // Delete only now that the server has confirmed it.
                await store.delete(chunk.id);
                this.lastRetry = null;
                this.options.onUploaded?.(chunk, outcome.response, outcome.duplicate);
                return;
            case "retry":
                this.lastRetry = outcome.reason;
                // Re-read, never write back `chunk`: it may have been confirmed
                // and deleted by another uploader while this request was in
                // flight (update() is then a no-op).
                await store.update(chunk.id, (current) => {
                    const attempts = current.attempts + 1;
                    return { ...current, attempts, nextAttemptAt: Date.now() + backoffDelay(attempts) };
                });
                return;
            case "reject":
                await store.update(chunk.id, (current) => ({ ...current, failed: outcome.reason }));
                return;
            case "halt":
                if (outcome.status === 410) {
                    // The server will never take audio for an ended session, so
                    // its chunks are dead weight; other sessions keep going.
                    const dropped = (await store.list()).filter((item) => item.sessionId === chunk.sessionId);
                    await Promise.all(dropped.map((item) => store.delete(item.id)));
                    this.options.onSessionEnded?.(chunk.sessionId, dropped.length);
                    return;
                }
                // 401/403: every request would fail the same way until the
                // token is fixed. Keep everything and wait for resume().
                this.halted = outcome.reason;
                return;
        }
    }
}
