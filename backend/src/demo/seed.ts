import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { getStorage } from "../lib/storage";
import { toMarkdownV2 } from "../services/summary.service";
import { generateRecording } from "./audio/recording";
import { pickEngine } from "./audio/tts";
import { buildDemoMeeting, DEMO_SPECS } from "./build";
import { replaceDemoData, type SeedMeeting } from "./demo.repository";
import { DEMO_EMAIL } from "./types";

/**
 * Seeds (or re-seeds) the demo account:
 *
 *   npm --prefix backend run demo:seed [-- --tts auto|sapi|espeak|tones] [-- --no-audio]
 *   node dist/demo/seed.js            (production image)
 *
 * Three synthetic meetings, fully processed, without a single Gemini or
 * Whisper call: transcripts, speakers, noise labels, v2 summaries with
 * evidence and action items come from src/demo/content. The recordings
 * are generated here, by local text-to-speech (or tones), and stored
 * under STORAGE_DIR/demo/. They are never committed: the repo keeps no
 * audio, and the script makes them again in a few seconds.
 *
 * Idempotent: every run replaces the demo account's meetings.
 */

const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const main = async () => {
  const withAudio = !process.argv.includes("--no-audio");
  const engine = withAudio ? await pickEngine(argValue("--tts") ?? process.env.DEMO_TTS ?? "auto") : null;
  const storage = getStorage();
  const now = new Date();

  const meetings: SeedMeeting[] = [];
  for (const spec of DEMO_SPECS) {
    let audioPath: string | null = null;
    let timings;

    if (engine) {
      const recording = await generateRecording(spec, engine, env.ffmpegPath);
      for (const ext of ["ogg", "wav"]) await storage.remove(`demo/${spec.key}.${ext}`);
      const key = `demo/${spec.key}.${recording.ext}`;
      await storage.put(key, recording.data);
      audioPath = storage.relativePath(key);
      timings = recording.timings;
      console.log(`  ${spec.key}: ${recording.engine} audio, ${(recording.data.length / 1024).toFixed(0)} KB -> ${audioPath}`);
    }

    const meeting = buildDemoMeeting(spec, { now, timings });
    meetings.push({ ...meeting, audioPath, markdown: toMarkdownV2(meeting.summary) });
  }

  const { ids } = await replaceDemoData(meetings);
  console.log(`Demo account ${DEMO_EMAIL} seeded with ${meetings.length} meetings:`);
  for (const meeting of meetings) console.log(`  ${meeting.key.padEnd(9)} ${ids[meeting.key]}  ${meeting.title}`);
  if (!env.demoMode) console.log("DEMO_MODE is off: set DEMO_MODE=true to show the \"Try the demo\" button.");
};

main()
  .catch((error: unknown) => {
    console.error("Demo seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
