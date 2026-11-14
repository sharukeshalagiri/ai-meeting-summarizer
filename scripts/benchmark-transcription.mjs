#!/usr/bin/env node
/**
 * Transcription benchmark (w1-asr): real-time factor, segment count and
 * word error rate of the ai-service's /transcribe on one clip.
 *
 *   npm run bench:asr -- --fetch-sample                 # public-domain clip
 *   npm run bench:asr -- --audio a.flac --reference a.txt
 *   options: --url http://localhost:5132  --layout mono|stereo-mic-left
 *            --runs 3  --language en  --json
 *
 * The ai-service must be running (its URL defaults to AI_SERVICE_URL or
 * http://localhost:8000) and must share a filesystem with this script,
 * because the clip is sent by path. Audio is never committed: the sample
 * is downloaded into recordings/benchmark/, which .gitignore excludes.
 *
 * RTF = processing seconds / audio seconds (lower is faster; < 1 is
 * faster than real time). The first run includes the model load, so it
 * is reported separately and the RTF is the median of the warm runs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Public-domain sample: President Kennedy's 1961 inaugural address (a US
 * government work), the clip openai/whisper ships for its own tests.
 */
export const SAMPLE = {
  url: "https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac",
  file: "jfk.flac",
  reference:
    "And so my fellow Americans, ask not what your country can do for you, " +
    "ask what you can do for your country.",
};

/** Lowercase, punctuation stripped, split on whitespace. */
export const normalizeWords = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/'(?!\p{L})|(?<!\p{L})'/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Word error rate: (substitutions + deletions + insertions) / reference
 * words, by word-level Levenshtein distance. 0 is perfect; it can exceed
 * 1 when the hypothesis has many insertions.
 */
export const wordErrorRate = (reference, hypothesis) => {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);

  for (let i = 1; i <= ref.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }

  return prev[hyp.length] / ref.length;
};

export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key.slice(2)] = true;
    else {
      args[key.slice(2)] = next;
      i += 1;
    }
  }
  return args;
};

const fetchSample = async () => {
  const dir = path.join(root, "recordings", "benchmark");
  const audio = path.join(dir, SAMPLE.file);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(audio)) {
    console.error(`Downloading ${SAMPLE.url}`);
    const response = await fetch(SAMPLE.url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    fs.writeFileSync(audio, Buffer.from(await response.arrayBuffer()));
  }

  return { audio, reference: SAMPLE.reference };
};

const transcribe = async (url, body) => {
  const started = performance.now();
  const response = await fetch(`${url.replace(/\/$/, "")}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const seconds = (performance.now() - started) / 1000;

  if (!response.ok) {
    throw new Error(`/transcribe returned ${response.status}: ${await response.text()}`);
  }

  return { seconds, result: await response.json() };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.AI_SERVICE_URL || "http://localhost:8000";
  const runs = Math.max(1, Number(args.runs) || 3);

  let audio;
  let reference;

  if (args["fetch-sample"]) {
    ({ audio, reference } = await fetchSample());
  } else if (args.audio && args.reference) {
    audio = path.resolve(String(args.audio));
    reference = fs.readFileSync(path.resolve(String(args.reference)), "utf8");
  } else {
    console.error("Usage: --fetch-sample, or --audio <file> --reference <text file>");
    process.exit(2);
  }

  const body = {
    file_path: path.resolve(audio),
    offset_ms: 0,
    channel_layout: args.layout || "mono",
    hints: [],
    language: args.language || null,
  };

  const timings = [];
  let last;
  for (let i = 0; i < runs + 1; i += 1) {
    const { seconds, result } = await transcribe(url, body);
    timings.push(seconds);
    last = result;
  }

  const audioSeconds = (Number(last.durationMs) || 0) / 1000;
  const warm = median(timings.slice(1));
  const report = {
    clip: path.basename(audio),
    model: last.model ?? null,
    channelLayout: body.channel_layout,
    audioSeconds: Number(audioSeconds.toFixed(2)),
    coldSeconds: Number(timings[0].toFixed(2)),
    warmSecondsMedian: Number(warm.toFixed(2)),
    rtf: audioSeconds > 0 ? Number((warm / audioSeconds).toFixed(3)) : null,
    segments: Array.isArray(last.segments) ? last.segments.length : 0,
    channels: [...new Set((last.segments ?? []).map((s) => s.channel ?? "none"))],
    wer: Number(wordErrorRate(reference, last.text).toFixed(4)),
    hypothesis: last.text,
  };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else for (const [key, value] of Object.entries(report)) console.log(`${key.padEnd(18)} ${Array.isArray(value) ? value.join(",") : value}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
