import { describe, expect, it } from "vitest";
import { SessionState, type KeyValueStorage } from "./sessionState.ts";

/**
 * Storage whose every get/set takes a few macrotasks, like
 * chrome.storage, so unserialized read-modify-writes would interleave.
 */
const slowStorage = () => {
  const data = new Map<string, unknown>();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
  const storage: KeyValueStorage = {
    get: async (key) => {
      await tick();
      const value = data.get(key);
      await tick();
      return value === undefined ? undefined : structuredClone(value);
    },
    set: async (key, value) => {
      await tick();
      data.set(key, structuredClone(value));
    },
    remove: async (key) => {
      await tick();
      data.delete(key);
    },
  };
  return { storage, data };
};

const session = (sessionId = "s1") => ({ sessionId, meetingId: `m-${sessionId}`, chunkCount: 0 });

describe("SessionState (lost-update protection)", () => {
  it("a progress update in flight cannot resurrect a session Stop cleared", async () => {
    const { storage, data } = slowStorage();
    const state = new SessionState(storage);
    await state.startSession(session());

    // Offscreen progress arrives, then the user clicks Stop before the
    // progress write lands.
    const progress = state.patchSession("s1", { chunkCount: 5 });
    const stop = (async () => {
      const stopped = await state.markStopping();
      await state.clearSession(stopped!.sessionId);
    })();

    await Promise.all([progress, stop]);

    expect(data.has("session")).toBe(false);
  });

  it("stopping only goes false -> true; later patches are dropped", async () => {
    const { storage } = slowStorage();
    const state = new SessionState(storage);
    await state.startSession(session());

    const stopping = state.markStopping();
    const late = state.patchSession("s1", { stopping: false, chunkCount: 9 });

    await stopping;
    expect(await late).toBe(false);
    expect(await state.getSession()).toMatchObject({ stopping: true, chunkCount: 0 });
  });

  it("a patch for an old session never touches the new one", async () => {
    const { storage } = slowStorage();
    const state = new SessionState(storage);
    await state.startSession(session("old"));
    await state.clearSession("old");
    await state.startSession(session("new"));

    expect(await state.patchSession("old", { chunkCount: 3 })).toBe(false);
    expect(await state.getSession()).toMatchObject({ sessionId: "new", chunkCount: 0 });
  });

  it("drain removing ended ids cannot drop an id Stop added meanwhile", async () => {
    const { storage } = slowStorage();
    const state = new SessionState(storage);
    await state.addPendingEnd("a");

    // The drain finished "a" and saves; Stop adds "b" in between.
    const drained = state.removePendingEnds(["a"]);
    const stopped = state.addPendingEnd("b");
    await Promise.all([drained, stopped]);

    expect(await state.getPendingEnds()).toEqual(["b"]);
  });

  it("two racing Starts: only one session is stored", async () => {
    const { storage } = slowStorage();
    const state = new SessionState(storage);

    const results = await Promise.allSettled([
      state.startSession(session("x")),
      state.startSession(session("y")),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await state.getSession())?.sessionId).toBe("x");
  });
});
