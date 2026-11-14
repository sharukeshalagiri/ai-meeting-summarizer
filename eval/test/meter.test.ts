import { describe, expect, it } from "vitest";
import { withRetry } from "../../backend/src/lib/gemini";
import { BudgetExceeded, GeminiMeter, classifyError, costOf, type CaseCalls } from "../src/meter";

const fakeModels = () => ({ generateContent: async (_p: Record<string, unknown>): Promise<unknown> => ({}) });

describe("GeminiMeter", () => {
  it("counts attempts, retries, 503s and gave-up requests per case", async () => {
    const meter = new GeminiMeter(10);
    const models = fakeModels();
    const script = ["503", "ok", "503", "503"];
    meter.install(models, async () => {
      const next = script.shift();
      if (next === "503") throw new Error("503 UNAVAILABLE: The model is overloaded");
      return { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } };
    });

    meter.currentCase = "a";
    const req = { model: "m", contents: "same" };
    await models.generateContent(req).catch(() => {});
    await models.generateContent(req); // the retry succeeds
    await models.generateContent({ model: "m", contents: "other" }).catch(() => {});
    await models.generateContent({ model: "m", contents: "other" }).catch(() => {}); // fails again, then given up

    expect(meter.forCase("a")).toMatchObject({ calls: 4, retries: 2, http503: 3, gaveUp: 1, refused: 0, inputTokens: 100, outputTokens: 20 });
    expect(meter.used).toBe(4);
  });

  it("refuses beyond the cap without sending, and withRetry does not retry the refusal", async () => {
    const meter = new GeminiMeter(1);
    const models = fakeModels();
    let sent = 0;
    meter.install(models, async () => {
      sent++;
      return {};
    });
    await models.generateContent({ model: "m", contents: "x" });
    await expect(withRetry(() => models.generateContent({ model: "m", contents: "y" }))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(sent).toBe(1);
    expect(meter.forCase("-").refused).toBe(1);
  });

  it("uninstall restores the original behaviour", async () => {
    const meter = new GeminiMeter(0);
    const models = { generateContent: async (_p: Record<string, unknown>): Promise<unknown> => "real" };
    const uninstall = meter.install(models);
    await expect(models.generateContent({})).rejects.toBeInstanceOf(BudgetExceeded);
    uninstall();
    await expect(models.generateContent({})).resolves.toBe("real");
  });

  it("classifies errors", () => {
    expect(classifyError(new Error("got status: 503 high demand"))).toBe("503");
    expect(classifyError(new Error("429 RESOURCE_EXHAUSTED"))).toBe("429");
    expect(classifyError(new Error("fetch failed"))).toBe("network");
    expect(classifyError(new Error("400 invalid argument"))).toBe("permanent");
    expect(classifyError(new BudgetExceeded(3))).toBe("refused");
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
