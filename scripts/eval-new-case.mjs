#!/usr/bin/env node
/**
 * Creates an evaluation case for one of your own, consented recordings.
 *
 *   npm run eval:new-case -- <slug> [--audio path/to/recording.wav] [--meeting <Meeting id>] [--mode project]
 *
 * Writes eval/cases/own/<slug>/ (gitignored, so nothing here is ever
 * committed):
 *   case.json      id, meetingId (for eval:import-corrections), meeting start
 *   expected.json  an empty answer key to fill in (same format as
 *                  fixtures/transcripts/README.md), or grow from your
 *                  review corrections with `npm run eval:import-corrections`
 *   audio.wav      a copy of --audio, if given: stereo, left = you
 * For WER/DER add reference.json ({ me, words: [{speaker,text,startMs,endMs}] }).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWN_DIR = path.join(root, "eval/cases/own");
const MODES = ["project", "lecture", "interview", "one-on-one", "general"];

export const createCase = ({ slug, audio, meeting, mode = "general", now = new Date() }, dir = OWN_DIR) => {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug ?? "")) {
    throw new Error("slug: lowercase letters, digits and dashes, e.g. weekly-sync-nov");
  }
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);

  const caseDir = path.join(dir, slug);
  if (fs.existsSync(caseDir)) throw new Error(`${path.relative(root, caseDir)} already exists`);
  fs.mkdirSync(caseDir, { recursive: true });

  const entry = {
    id: `own-${slug}`,
    type: "own",
    ...(meeting ? { meetingId: meeting } : {}),
    meetingStart: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
  fs.writeFileSync(path.join(caseDir, "case.json"), `${JSON.stringify(entry, null, 2)}\n`);
  fs.writeFileSync(
    path.join(caseDir, "expected.json"),
    `${JSON.stringify({ transcript: "(audio)", mode, mustAppear: [], mustNotAppear: [] }, null, 2)}\n`
  );
  if (audio) fs.copyFileSync(path.resolve(audio), path.join(caseDir, "audio.wav"));
  return caseDir;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const dir = createCase({ slug: args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")), audio: value("audio"), meeting: value("meeting"), mode: value("mode") });
    console.log(`created ${path.relative(root, dir)} (gitignored). Fill in expected.json, or run npm run eval:import-corrections.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
