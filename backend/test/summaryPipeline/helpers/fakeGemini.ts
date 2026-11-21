/**
 * A scripted stand-in for the Gemini client, so the summary pipeline
 * runs end to end in tests without the network. Each pipeline pass is
 * recognised by its system prompt ("CLEAN pass", "EXTRACT pass", ...).
 *
 * The fake only "sees" what the pipeline sends it: EXTRACT can cite
 * only the [#idx] ids present in its input, exactly like the real model
 * is told to, so a test can tell whether CLEAN kept small talk out.
 */

export type Step = "classify" | "clean" | "extract" | "reduce" | "verify";

export interface RecordedCall {
  step: Step;
  model: string;
  temperature: unknown;
  system: string;
  contents: string;
  /** Segment ids present in the contents. */
  ids: number[];
}

type Json = Record<string, unknown>;

export interface Script {
  classify?: (call: RecordedCall) => Json;
  clean?: (call: RecordedCall) => Json;
  extract?: (call: RecordedCall) => Json;
  reduce?: (call: RecordedCall, parts: Json[]) => Json;
  verify?: (call: RecordedCall, draft: Json) => Json;
  /** Throw for a step to simulate an outage. */
  fail?: Partial<Record<Step, Error>>;
}

export const calls: RecordedCall[] = [];
let script: Script = {};

export const setScript = (next: Script) => {
  script = next;
  calls.length = 0;
};

const stepOf = (system: string): Step => {
  if (system.includes("CLASSIFY pass")) return "classify";
  if (system.includes("CLEAN pass")) return "clean";
  if (system.includes("EXTRACT pass")) return "extract";
  if (system.includes("REDUCE pass")) return "reduce";
  if (system.includes("VERIFY pass")) return "verify";
  throw new Error(`Unknown prompt: ${system.slice(0, 60)}`);
};

export const idsIn = (contents: string): number[] =>
  [...contents.matchAll(/\[#(\d+) /g)].map((match) => Number(match[1]));

/** Default VERIFY: returns the draft with every confidence set to 0.9. */
const echoVerify = (draft: Json): Json =>
  JSON.parse(
    JSON.stringify(draft, (key, value) => (key === "confidence" ? 0.9 : value))
  );

/** Default REDUCE: concatenates the parts' lists. */
const concatReduce = (parts: Json[]): Json => {
  const merged: Json = { ...parts[0] };

  for (const part of parts.slice(1)) {
    for (const [key, value] of Object.entries(part)) {
      if (Array.isArray(value) && Array.isArray(merged[key])) {
        merged[key] = [...(merged[key] as unknown[]), ...value];
      }
    }
  }

  merged.tldr = parts.map((part) => part.tldr).join(" ");
  return merged;
};

export const fakeClient = {
  models: {
    generateContent: async (request: {
      model: string;
      contents: string;
      config: { systemInstruction: string; temperature?: unknown };
    }) => {
      const system = request.config.systemInstruction;
      const step = stepOf(system);
      const call: RecordedCall = {
        step,
        model: request.model,
        temperature: request.config.temperature,
        system,
        contents: request.contents,
        ids: idsIn(request.contents),
      };
      calls.push(call);

      const failure = script.fail?.[step];
      if (failure) throw failure;

      let output: Json;

      switch (step) {
        case "classify":
          output = script.classify?.(call) ?? { mode: "GENERAL", confidence: 0.5, reason: "" };
          break;
        case "clean":
          output =
            script.clean?.(call) ??
            { labels: call.ids.map((idx) => ({ idx, label: "substantive" })) };
          break;
        case "extract":
          output = script.extract?.(call) ?? { tldr: "Nothing." };
          break;
        case "reduce": {
          const parts = request.contents
            .split(/Part \d+:\n/)
            .filter((chunk) => chunk.trim())
            .map((chunk) => JSON.parse(chunk.trim()) as Json);
          output = script.reduce?.(call, parts) ?? concatReduce(parts);
          break;
        }
        case "verify": {
          const draftText = request.contents
            .split("Draft summary:\n")[1]
            .split("\n\nCited transcript lines:")[0];
          const draft = JSON.parse(draftText) as Json;
          output = script.verify?.(call, draft) ?? echoVerify(draft);
          break;
        }
      }

      return { text: JSON.stringify(output) };
    },
  },
};
