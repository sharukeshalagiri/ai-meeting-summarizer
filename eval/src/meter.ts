/**
 * Counts, times, paces and caps every Gemini request the evaluation makes.
 *
 * The pipeline is never modified. The meter wraps the global `fetch` and
 * watches requests to the Gemini API host. @google/genai looks `fetch` up
 * at call time, so every attempt is seen, including each retry inside
 * withRetry, whichever copy of the SDK or of lib/gemini.ts made it.
 *
 * Why fetch and not the client: under tsx the harness (ESM) and the
 * pipeline (CommonJS) load backend/src/lib/gemini.ts as two module
 * instances, each with its own client. Wrapping the client the harness
 * could see missed every pipeline request in the first real run (see
 * docs/decisions/w2-eval.md, "Meter fix").
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
const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|network|abort|timeout|timed out/i;

export const classifyError = (error: unknown): Outcome => {
  if (error instanceof BudgetExceeded) return "refused";
  const detail = error instanceof Error ? `${error.name} ${error.message} ${String((error as { status?: unknown }).status ?? "")}` : String(error);
  if (TRANSIENT_503.test(detail)) return "503";
  if (TRANSIENT_429.test(detail)) return "429";
  if (NETWORK.test(detail)) return "network";
  return "permanent";
};

export const classifyStatus = (status: number): Outcome => {
  if (status >= 200 && status < 300) return "ok";
  if (status === 503 || status === 500 || status === 502 || status === 504) return "503";
  if (status === 429) return "429";
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

/** Gemini API requests: generativelanguage.googleapis.com/.../models/<model>:<method>. */
export const GEMINI_HOST = /(^|\.)generativelanguage\.googleapis\.com$/;

export const geminiModelOf = (url: URL): string | null => {
  if (!GEMINI_HOST.test(url.hostname)) return null;
  const m = url.pathname.match(/\/models\/([^/:]+):/);
  return m ? m[1] : "?";
};

type Fetch = typeof fetch;

export interface FetchMeterOptions {
  /** Requests per minute allowed per model (free tier: 5). 0 = no pacing. */
  rpm?: number;
  /** Abort a request that has not answered after this long (a hang is a network failure). */
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const urlOf = (input: Parameters<Fetch>[0]): URL | null => {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  } catch {
    return null;
  }
};

export class GeminiMeter {
  readonly records: CallRecord[] = [];
  currentCase = "-";
  private sent = 0;
  private lastSent = new Map<string, number>();

  constructor(readonly cap: number) {}

  get used(): number {
    return this.sent;
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.sent);
  }

  /**
   * Wraps `target.fetch` (globalThis by default). Non-Gemini requests pass
   * through untouched. `impl` replaces the real network (tests).
   */
  installFetch(target: { fetch: Fetch } = globalThis, options: FetchMeterOptions = {}, impl?: Fetch): () => void {
    const original = target.fetch;
    const send: Fetch = impl ?? original.bind(target);
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = options.now ?? Date.now;
    const interval = options.rpm && options.rpm > 0 ? Math.ceil(60_000 / options.rpm) : 0;
    const timeoutMs = options.requestTimeoutMs ?? 0;

    const metered: Fetch = async (input, init) => {
      const url = urlOf(input);
      const model = url ? geminiModelOf(url) : null;
      if (!model) return send(input, init);

      const body = typeof init?.body === "string" ? init.body : "";
      const record: CallRecord = {
        caseId: this.currentCase,
        model,
        request: hash(`${url!.pathname}\n${body}`),
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

      // Free-tier limits are per model per minute; space requests out
      // instead of burning attempts on 429s.
      if (interval) {
        const wait = (this.lastSent.get(model) ?? -Infinity) + interval - now();
        if (wait > 0) await sleep(wait);
      }
      this.lastSent.set(model, now());
      this.sent++;

      const signals = [init?.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
        (s): s is AbortSignal => Boolean(s)
      );
      const started = now();
      try {
        const response = await send(input, {
          ...init,
          ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
        });
        record.outcome = classifyStatus(response.status);
        if (record.outcome === "ok") {
          try {
            const usage = ((await response.clone().json()) as { usageMetadata?: Record<string, unknown> }).usageMetadata ?? {};
            record.inputTokens = Number(usage.promptTokenCount ?? 0) || 0;
            record.outputTokens =
              (Number(usage.candidatesTokenCount ?? 0) || 0) + (Number(usage.thoughtsTokenCount ?? 0) || 0);
          } catch {
            // Tokens are a nice-to-have; an unreadable body is the SDK's problem.
          }
        }
        return response;
      } catch (error) {
        record.outcome = classifyError(error) === "permanent" ? "network" : classifyError(error);
        throw error;
      } finally {
        record.ms = now() - started;
        this.records.push(record);
      }
    };

    target.fetch = metered;
    return () => {
      target.fetch = original;
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
