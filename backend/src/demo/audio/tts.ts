import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { parseWav, toneClip, type PcmClip } from "./wav";

const run = promisify(execFile);

/**
 * Text-to-speech for the demo recordings, with no network and no
 * account: Windows SAPI (built into Windows), else espeak-ng / espeak
 * (one apt package on Linux), else synthesized tones. Each line is
 * spoken separately, so the segment times come from the real audio.
 */

export type TtsEngine = "sapi" | "espeak" | "tones";

export interface TtsLine {
  text: string;
  /** Index of the speaker in the meeting, picks the voice. */
  speaker: number;
  /** Duration to use for the tone fallback. */
  fallbackMs: number;
}

const canRun = async (file: string, args: string[]) => {
  try {
    await run(file, args, { timeout: 20_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

let espeakBinary: string | null = null;

const findEspeak = async (): Promise<string | null> => {
  for (const binary of ["espeak-ng", "espeak"]) {
    if (await canRun(binary, ["--version"])) return binary;
  }
  return null;
};

/** The best engine on this machine, or the one asked for. */
export const pickEngine = async (wanted: string = "auto"): Promise<TtsEngine> => {
  if (wanted === "tones") return "tones";

  if ((wanted === "auto" || wanted === "sapi") && process.platform === "win32") {
    if (await canRun("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech"])) {
      return "sapi";
    }
  }

  if (wanted === "auto" || wanted === "espeak") {
    espeakBinary = await findEspeak();
    if (espeakBinary) return "espeak";
  }

  if (wanted !== "auto") throw new Error(`Text-to-speech engine "${wanted}" is not available here.`);
  return "tones";
};

/**
 * One PowerShell process speaks every line of a meeting (starting one
 * per line would take a second each). Voices rotate over the installed
 * ones, with a small rate change so two speakers on the same voice still
 * sound different.
 */
const SAPI_SCRIPT = `
param([string]$JobFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$jobs = Get-Content -Raw -Encoding UTF8 $JobFile | ConvertFrom-Json
foreach ($job in $jobs) {
  $synth.SelectVoice($voices[$job.speaker % $voices.Count])
  $synth.Rate = [int]((([math]::Floor($job.speaker / $voices.Count)) % 3) - 1)
  $synth.SetOutputToWaveFile($job.out, $format)
  $synth.Speak($job.text)
  $synth.SetOutputToNull()
}
$synth.Dispose()
`;

const ESPEAK_VOICES = ["en-us+m3", "en-us+f3", "en-us+m1", "en-us+f4", "en-us+m5", "en-us+f2"];

export const speakLines = async (engine: TtsEngine, lines: TtsLine[]): Promise<PcmClip[]> => {
  if (engine === "tones") return lines.map((line) => toneClip(line.fallbackMs, line.speaker));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ams-demo-tts-"));
  try {
    const files = lines.map((_, i) => path.join(dir, `line-${String(i).padStart(3, "0")}.wav`));

    if (engine === "sapi") {
      const script = path.join(dir, "speak.ps1");
      const jobFile = path.join(dir, "jobs.json");
      await fs.writeFile(script, SAPI_SCRIPT, "utf8");
      await fs.writeFile(
        jobFile,
        JSON.stringify(lines.map((line, i) => ({ text: line.text, speaker: line.speaker, out: files[i] }))),
        "utf8"
      );
      await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-JobFile", jobFile],
        { timeout: 10 * 60_000, windowsHide: true }
      );
    } else {
      const binary = espeakBinary ?? (await findEspeak());
      if (!binary) throw new Error("espeak is not installed");
      for (const [i, line] of lines.entries()) {
        await run(binary, ["-v", ESPEAK_VOICES[line.speaker % ESPEAK_VOICES.length], "-s", "165", "-w", files[i], line.text], {
          timeout: 60_000,
        });
      }
    }

    return await Promise.all(files.map(async (file) => parseWav(await fs.readFile(file))));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

/**
 * Compresses the assembled WAV to Ogg Opus with ffmpeg when it is
 * installed (about 20x smaller), else keeps the WAV. Returns the bytes
 * and the file extension to store them under.
 */
export const encodeForPlayback = async (wav: Buffer, ffmpeg = "ffmpeg"): Promise<{ data: Buffer; ext: "ogg" | "wav" }> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ams-demo-enc-"));
  try {
    const input = path.join(dir, "in.wav");
    const output = path.join(dir, "out.ogg");
    await fs.writeFile(input, wav);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-c:a", "libopus", "-b:a", "40k", output], {
      timeout: 120_000,
      windowsHide: true,
    });
    return { data: await fs.readFile(output), ext: "ogg" };
  } catch {
    return { data: wav, ext: "wav" };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};
