import { describe, expect, it } from "vitest";
import { withRetry } from "../../backend/src/lib/gemini";
import { BudgetExceeded, GeminiMeter, classifyError, classifyStatus, costOf, geminiModelOf, type CaseCalls } from "../src/meter";
import { gemini503, geminiOk } from "./fakeGemini";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";
const post = (body: string) => ({ method: "POST", body });

describe("GeminiMeter.installFetch", () => {
  it("counts attempts, retries, 503s and gave-up requests per case", async () => {
    const meter = new GeminiMeter(10);
    const target = { fetch: globalThis.fetch };
    const script = ["503", "ok", "503", "503"];
    meter.installFetch(target, {}, async () => (script.shift() === "503" ? gemini503() : geminiOk({}, { in: 100, out: 20 })));

    meter.currentCase = "a";
    await target.fetch(GEMINI, post("same"));
    await target.fetch(GEMINI, post("same")); // the retry succeeds
    await target.fetch(GEMINI, post("other"));
    await target.fetch(GEMINI, post("other")); // fails again, then given up

    expect(meter.forCase("a")).toMatchObject({ calls: 4, retries: 2, http503: 3, gaveUp: 1, refused: 0, inputTokens: 100, outputTokens: 20 });
    expect(meter.forCase("a").byModel).toHaveProperty("gemini-flash-latest");
    expect(meter.used).toBe(4);
  });

  it("passes non-Gemini requests through uncounted", async () => {
    const meter = new GeminiMeter(0);
    const target = { fetch: globalThis.fetch };
    meter.installFetch(target, {}, async () => new Response("ai-service"));
    await expect((await target.fetch("http://localhost:8000/transcribe")).text()).resolves.toBe("ai-service");
    expect(meter.used).toBe(0);
  });

  it("refuses beyond the cap without sending, and withRetry does not retry the refusal", async () => {
    const meter = new GeminiMeter(1);
    const target = { fetch: globalThis.fetch };
    let sent = 0;
    meter.installFetch(target, {}, async () => {
      sent++;
      return geminiOk({});
    });
    await target.fetch(GEMINI, post("x"));
    await expect(withRetry(() => target.fetch(GEMINI, post("y")))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(sent).toBe(1);
    expect(meter.forCase("-").refused).toBe(1);
  });

  it("paces requests per model to the requests-per-minute limit", async () => {
    let clock = 0;
    const waits: number[] = [];
    const meter = new GeminiMeter(10);
    const target = { fetch: globalThis.fetch };
    meter.installFetch(
      target,
      { rpm: 5, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } },
      async () => geminiOk({})
    );
    await target.fetch(GEMINI, post("1"));
    await target.fetch(GEMINI, post("2"));
    // A different model has its own quota: no wait.
    await target.fetch(GEMINI.replace("gemini-flash-latest", "gemini-flash-lite-latest"), post("3"));
    expect(waits).toEqual([12_000]);
  });

  it("aborts a hanging request and counts it as a network failure", async () => {
    const meter = new GeminiMeter(5);
    const target = { fetch: globalThis.fetch };
    meter.installFetch(target, { requestTimeoutMs: 5 }, (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
    );
    await expect(target.fetch(GEMINI, post("hang"))).rejects.toBeDefined();
    expect(meter.forCase("-")).toMatchObject({ network: 1, gaveUp: 1 });
  });

  it("uninstall restores the original fetch", () => {
    const meter = new GeminiMeter(1);
    const original = async () => new Response("x");
    const target = { fetch: original as unknown as typeof fetch };
    const uninstall = meter.installFetch(target);
    expect(target.fetch).not.toBe(original);
    uninstall();
    expect(target.fetch).toBe(original);
  });
});

describe("classification", () => {
  it("classifies errors and statuses", () => {
    expect(classifyError(new Error("got status: 503 high demand"))).toBe("503");
    expect(classifyError(new Error("429 RESOURCE_EXHAUSTED"))).toBe("429");
    expect(classifyError(new TypeError("fetch failed"))).toBe("network");
    expect(classifyError(new Error("400 invalid argument"))).toBe("permanent");
    expect(classifyError(new BudgetExceeded(3))).toBe("refused");
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(503)).toBe("503");
    expect(classifyStatus(429)).toBe("429");
    expect(classifyStatus(400)).toBe("permanent");
  });

  it("recognises Gemini API URLs and their model", () => {
    expect(geminiModelOf(new URL(GEMINI))).toBe("gemini-flash-latest");
    expect(geminiModelOf(new URL("http://localhost:8000/transcribe"))).toBeNull();
  });
});

describe("costOf", () => {
  const pricing = { asOf: "x", currency: "USD", models: { m: { inputPerMTok: 1, outputPerMTok: 2 } } };
  const calls: CaseCalls = {
    calls: 1, retries: 0, http503: 0, http429: 0, network: 0, gaveUp: 0, refused: 0, ms: 0, inputTokens: 0, outputTokens: 0,
    byModel: { m: { calls: 1, inputTokens: 1_000_000, outputTokens: 500_000 } },
  };

  it("prices tokens per model, and is null for an unpriced model", () => {
    expect(costOf(calls, pricing)).toBe(2);
    expect(costOf({ ...calls, byModel: { other: calls.byModel.m } }, pricing)).toBeNull();
  });
});
