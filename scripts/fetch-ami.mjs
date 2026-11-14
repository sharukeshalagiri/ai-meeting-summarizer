#!/usr/bin/env node
/**
 * Downloads a fixed list of AMI Meeting Corpus meetings for the audio
 * part of the evaluation (WER, DER, "my lines labelled as me").
 *
 *   npm run eval:fetch-ami                 the default meetings below
 *   node scripts/fetch-ami.mjs --meetings ES2004a,IS1009a --keep-headsets
 *
 * Source: https://groups.inf.ed.ac.uk/ami/corpus/ (no account needed).
 * Licence: CC BY 4.0. Everything lands in eval/data/ami/, which is
 * gitignored: audio and transcripts are never committed.
 *
 * Per meeting it writes:
 *   stereo.wav      left = Headset-0 (the "me" speaker), right = the other
 *                   headsets mixed: the capture contract's stereo form.
 *   reference.json  { meeting, me, words: [{speaker,text,startMs,endMs}] }
 *                   from the manual word annotations.
 * The individual headset files are deleted after mixing unless
 * --keep-headsets is given. Needs ffmpeg on PATH, and `tar` (bsdtar on
 * Windows) or `unzip` for the annotation archive.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Kick-off ("a") meetings from the AMI test and dev sets: short, 4 speakers each. */
export const DEFAULT_MEETINGS = ["ES2004a", "IS1009a", "TS3003a", "ES2011a", "IS1008a"];

const AUDIO_BASE = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus";
const ANNOTATIONS_URL = "https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip";

/* ---------- pure parsers (tested in eval/test) ---------- */

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
};

const decode = (text) =>
  text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Words of one speaker from an AMI `*.words.xml` file. Punctuation
 * (`punc="true"`) and words without times are skipped; other elements
 * (vocal sounds, gaps, disfluency markers) are not <w> and are ignored.
 */
export const parseWordsXml = (xml, speaker) => {
  const words = [];
  for (const m of xml.matchAll(/<w\b([^>]*)>([^<]*)<\/w>/g)) {
    const tag = m[1];
    if (attr(tag, "punc") === "true") continue;
    const startAttr = attr(tag, "starttime");
    const endAttr = attr(tag, "endtime");
    const start = Number(startAttr);
    const end = Number(endAttr);
    const text = decode(m[2]).trim();
    // Number(null) is 0, so a missing time must be caught before converting.
    if (!text || startAttr === null || endAttr === null || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    words.push({ speaker, text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
  }
  return words;
};

/**
 * Agent letter -> headset channel for one meeting, from
 * corpusResources/meetings.xml (`<speaker nxt_agent="A" channel="1" .../>`).
 */
export const parseMeetingChannels = (xml, meeting) => {
  const block = xml.match(new RegExp(`<meeting\\b[^>]*observation="${meeting}"[^>]*>([\\s\\S]*?)</meeting>`));
  const channels = {};
  if (!block) return channels;
  for (const m of block[1].matchAll(/<speaker\b([^>]*)\/?>/g)) {
    const agent = attr(m[1], "nxt_agent");
    const channel = attr(m[1], "channel");
    if (agent && channel !== null) channels[agent] = Number(channel);
  }
  return channels;
};

/** All speakers' words, time ordered, with the Headset-0 speaker as "me". */
export const buildReference = (meeting, wordsByAgent, channels) => {
  const agents = Object.keys(wordsByAgent).sort();
  const me = Object.entries(channels).find(([, ch]) => ch === 0)?.[0] ?? agents[0];
  const words = agents
    .flatMap((agent) => wordsByAgent[agent])
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { meeting, me, words };
};

/* ---------- download ---------- */

const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  return r.status === 0;
};

const download = async (url, dest) => {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return fs.statSync(dest).size;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`GET ${url} -> ${response.status}`);
  const partial = `${dest}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  fs.renameSync(partial, dest);
  return fs.statSync(dest).size;
};

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const extract = (zip, dir, members) => {
  fs.mkdirSync(dir, { recursive: true });
  return run("tar", ["-xf", zip, "-C", dir, ...members]) || run("unzip", ["-o", "-q", zip, ...members, "-d", dir]);
};

const main = async () => {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const meetings = value("meetings")?.split(",").filter(Boolean) ?? DEFAULT_MEETINGS;
  const outDir = path.resolve(root, value("out") ?? "eval/data/ami");
  const keepHeadsets = args.includes("--keep-headsets");

  if (!run("ffmpeg", ["-version"], { stdio: "ignore" })) {
    throw new Error("ffmpeg is not on PATH; it is needed to build the stereo files.");
  }

  fs.mkdirSync(outDir, { recursive: true });
  const zip = path.join(outDir, "ami_public_manual_1.6.2.zip");
  console.log(`annotations: ${mb(await download(ANNOTATIONS_URL, zip))}`);

  const annotations = path.join(outDir, "annotations");
  const members = ["corpusResources/meetings.xml", ...meetings.flatMap((m) => ["A", "B", "C", "D", "E"].map((a) => `words/${m}.${a}.words.xml`))];
  // Not every meeting has an E speaker; extract what exists one by one.
  for (const member of members) {
    if (!fs.existsSync(path.join(annotations, member))) extract(zip, annotations, [member]);
  }

  const meetingsXml = fs.readFileSync(path.join(annotations, "corpusResources/meetings.xml"), "utf8");
  let total = 0;

  for (const meeting of meetings) {
    const dir = path.join(outDir, meeting);
    fs.mkdirSync(dir, { recursive: true });

    const wordsByAgent = {};
    for (const agent of ["A", "B", "C", "D", "E"]) {
      const file = path.join(annotations, "words", `${meeting}.${agent}.words.xml`);
      if (fs.existsSync(file)) wordsByAgent[agent] = parseWordsXml(fs.readFileSync(file, "utf8"), agent);
    }
    const channels = parseMeetingChannels(meetingsXml, meeting);
    const reference = buildReference(meeting, wordsByAgent, channels);
    fs.writeFileSync(path.join(dir, "reference.json"), JSON.stringify(reference));

    const stereo = path.join(dir, "stereo.wav");
    if (!fs.existsSync(stereo)) {
      const headsets = [];
      for (let ch = 0; ch < Object.keys(wordsByAgent).length; ch++) {
        const file = path.join(dir, `${meeting}.Headset-${ch}.wav`);
        const size = await download(`${AUDIO_BASE}/${meeting}/audio/${meeting}.Headset-${ch}.wav`, file);
        total += size;
        console.log(`${meeting} Headset-${ch}: ${mb(size)}`);
        headsets.push(file);
      }

      const others = headsets.slice(1);
      const filter =
        `${others.map((_, i) => `[${i + 1}:a]`).join("")}amix=inputs=${others.length}:duration=longest:normalize=0[r];` +
        `[0:a][r]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[a]`;
      const ok = run("ffmpeg", [
        "-y", "-loglevel", "error",
        ...headsets.flatMap((f) => ["-i", f]),
        "-filter_complex", filter, "-map", "[a]", "-ar", "16000", stereo,
      ]);
      if (!ok) throw new Error(`ffmpeg could not build ${stereo}`);
      if (!keepHeadsets) headsets.forEach((f) => fs.rmSync(f));
    }

    const minutes = (reference.words.at(-1)?.endMs ?? 0) / 60000;
    console.log(
      `${meeting}: me = ${reference.me}, ${reference.words.length} words, ~${minutes.toFixed(1)} min, stereo ${mb(fs.statSync(stereo).size)}`
    );
  }

  console.log(`downloaded ${mb(total)} of audio into ${path.relative(root, outDir)} (gitignored)`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
