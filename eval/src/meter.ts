/**
 * Counts, times and caps every Gemini request the evaluation makes.
 *
 * The pipeline is never modified: the meter wraps `generateContent` on
 * the backend's single shared client (lib/gemini.ts getClient()), so
 * every request made through it, including each retry attempt inside
 * withRetry, passes through here.
 *
 * Why it matters for accuracy: the pipeline deliberately swallows some
 * failures (a failed CLEAN batch counts as substantive, a failed VERIFY
 * keeps the draft). An outage would then look like a worse summary. The
 * meter sees the failed attempts, so the harness can mark the case
 * INFRA_ERROR instead of scoring it.
 */

export type Outcome = "ok" | "503" | "429" | "network" | "permanent" | "refused";

export interface CallRecord {
  caseId: string;
  model: string;
  /** Hash of the request; consecutive equal hashes are retries. */
  request: string;
  outcome: Outcome;
  ms: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CaseCalls {
  /** Requests sent (every attempt counts; refusals are not sent). */
  calls: number;
  retries: number;
  http503: number;
  http429: number;
  network: number;
  /** Requests whose last attempt still failed transiently. */
  gaveUp: number;
  refused: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

/** Thrown instead of sending a request once the cap is reached. Its
 * message avoids every word withRetry treats as transient, so it is not
 * retried. */
export class BudgetExceeded extends Error {
  constructor(cap: number) {
    super(`Eval Gemini call cap of ${cap} reached; request not sent.`);
    this.name = "BudgetExceeded";
  }
}

const TRANSIENT_503 = /unavailable|overloaded|high demand|503/i;
const TRANSIENT_429 = /429|rate.?limit|resource.?exhausted|quota/i;
const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|network/i;

export const classifyError = (error: unknown): Outcome => {
  if (error instanceof BudgetExceeded) return "refused";
  const detail = error instanceof Error ? `${error.message} ${String((error as { status?: unknown }).status ?? "")}` : String(error);
  if (TRANSIENT_503.test(detail)) return "503";
  if (TRANSIENT_429.test(detail)) return "429";
  if (NETWORK.test(detail)) return "network";
  return "permanent";
};

/** FNV-1a, enough to tell requests apart. */
const hash = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
};

type GenerateContent = (params: Record<string, unknown>) => Promise<unknown>;

export class GeminiMeter {
  readonly records: CallRecord[] = [];
  currentCase = "-";
  private sent = 0;

  constructor(readonly cap: number) {}

  get used(): number {
    return this.sent;
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.sent);
  }

  /**
   * Wraps `models.generateContent` in place. `impl` replaces the real
   * request (tests, replay); by default the original method is called.
   */
  install(models: { generateContent: GenerateContent }, impl?: GenerateContent): () => void {
    const original = models.generateContent.bind(models);
    const send = impl ?? original;

    models.generateContent = async (params: Record<string, unknown> = {}) => {
      const model = String(params.model ?? "?");
      const config = (params.config ?? {}) as Record<string, unknown>;
      const request = hash(JSON.stringify([model, params.contents, config.systemInstruction]));
      const record: CallRecord = {
        caseId: this.currentCase,
        model,
        request,
        outcome: "ok",
        ms: 0,
        inputTokens: 0,
        outputTokens: 0,
      };

      if (this.sent >= this.cap) {
        record.outcome = "refused";
        this.records.push(record);
        throw new BudgetExceeded(this.cap);
      }

      this.sent++;
      const started = Date.now();
      try {
        const response = (await send(params)) as { usageMetadata?: Record<string, unknown> } | undefined;
        const usage = response?.usageMetadata ?? {};
        record.inputTokens = Number(usage.promptTokenCount ?? 0) || 0;
        record.outputTokens =
          (Number(usage.candidatesTokenCount ?? 0) || 0) + (Number(usage.thoughtsTokenCount ?? 0) || 0);
        return response;
      } catch (error) {
        record.outcome = classifyError(error);
        throw error;
      } finally {
        record.ms = Date.now() - started;
        this.records.push(record);
      }
    };

    return () => {
      models.generateContent = original;
    };
  }

  forCase(caseId: string): CaseCalls {
    const records = this.records.filter((r) => r.caseId === caseId);
    const out: CaseCalls = {
      calls: 0,
      retries: 0,
      http503: 0,
      http429: 0,
      network: 0,
      gaveUp: 0,
      refused: 0,
      ms: 0,
      inputTokens: 0,
      outputTokens: 0,
      byModel: {},
    };

    records.forEach((record, i) => {
      if (record.outcome === "refused") {
        out.refused++;
        return;
      }
      out.calls++;
      out.ms += record.ms;
      out.inputTokens += record.inputTokens;
      out.outputTokens += record.outputTokens;
      const model = (out.byModel[record.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      model.calls++;
      model.inputTokens += record.inputTokens;
      model.outputTokens += record.outputTokens;
      if (record.outcome === "503") out.http503++;
      if (record.outcome === "429") out.http429++;
      if (record.outcome === "network") out.network++;

      const previous = records[i - 1];
      if (previous && previous.request === record.request && previous.outcome !== "ok") out.retries++;

      const next = records[i + 1];
      const transient = record.outcome === "503" || record.outcome === "429" || record.outcome === "network";
      const retried = next && next.request === record.request && next.outcome !== "refused";
      if (transient && !retried) out.gaveUp++;
    });

    return out;
  }
}

/** Price per million tokens, from eval/pricing.json. */
export interface Pricing {
  asOf: string;
  currency: string;
  models: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

export const costOf = (calls: CaseCalls, pricing: Pricing): number | null => {
  let total = 0;
  for (const [model, usage] of Object.entries(calls.byModel)) {
    const price = pricing.models[model];
    if (!price) return null;
    total += (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1e6;
  }
  return total;
};
