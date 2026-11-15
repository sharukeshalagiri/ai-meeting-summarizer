import { vi } from "vitest";
import { JUDGE_SYSTEM } from "../src/judge";

/**
 * A fake of the Gemini REST endpoint, used as the `fetch` underneath the
 * meter. The real @google/genai SDK, lib/gemini.ts and the pipeline run
 * unchanged on top of it, so tests exercise the same path as a real run:
 * if the meter ever stops seeing requests, these tests count zero.
 */

export type Step = "clean" | "extract" | "verify" | "reduce" | "judge" | "other";

interface GeminiBody {
  contents?: { parts?: { text?: string }[] }[];
  systemInstruction?: { parts?: { text?: string }[] };
}

export const stepOf = (body: GeminiBody): Step => {
  const contents = body.contents?.[0]?.parts?.[0]?.text ?? "";
  const system = body.systemInstruction?.parts?.[0]?.text ?? "";
  if (system === JUDGE_SYSTEM) return "judge";
  if (contents.startsWith("Label every segment")) return "clean";
  if (contents.startsWith("Draft summary")) return "verify";
  if (contents.startsWith("Part 1:")) return "reduce";
  if (contents.includes("Transcript:")) return "extract";
  return "other";
};

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

export const geminiOk = (value: unknown, tokens = { in: 1000, out: 200 }) =>
  json(200, {
    candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: tokens.in, candidatesTokenCount: tokens.out },
  });

export const gemini503 = () =>
  json(503, { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } });

export const gemini429 = () =>
  json(429, { error: { code: 429, message: "You exceeded your current quota.", status: "RESOURCE_EXHAUSTED" } });

export interface FakeGeminiOptions {
  /** Answer for each step. */
  answer: (step: Step) => unknown;
  /** Override a step's n-th request (1-based) with an error response, or throw for a network failure. */
  fail?: (step: Step, n: number) => Response | Error | null;
}

export const fakeGeminiFetch = (options: FakeGeminiOptions) => {
  const seen: Partial<Record<Step, number>> = {};
  const models: string[] = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (!url.hostname.endsWith("generativelanguage.googleapis.com")) throw new Error(`unexpected request to ${url.hostname}`);
    models.push(url.pathname.match(/\/models\/([^/:]+):/)?.[1] ?? "?");

    const step = stepOf(JSON.parse(String(init?.body ?? "{}")) as GeminiBody);
    seen[step] = (seen[step] ?? 0) + 1;
    const failure = options.fail?.(step, seen[step]!);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    return geminiOk(options.answer(step));
  });
  return { impl: impl as unknown as typeof fetch, mock: impl, seen, models };
};
