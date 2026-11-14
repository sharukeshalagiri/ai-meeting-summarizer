// GENERATED from frontend/src/lib/capture/levels.ts by
// extension/scripts/build-capture.mjs. Do not edit; edit the source.
/**
 * Per-channel level meters and the "channel silent for 30 s" warning.
 *
 * A silent left channel usually means a muted or wrong mic; a silent
 * right channel means the tab audio is not being captured (or nobody
 * is talking). Either way the user should know before the meeting ends.
 */
/** ~ -60 dBFS: below this a channel counts as silent (same idea as w1-asr's SILENT_CHANNEL_RMS). */
export const SILENCE_RMS = 0.001;
export const SILENCE_WARN_MS = 30_000;
export const rms = (samples) => {
    if (samples.length === 0)
        return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++)
        sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
};
/** 0..1 for a meter bar: -60 dBFS -> 0, 0 dBFS -> 1. */
export const meterLevel = (value) => {
    if (value <= 0)
        return 0;
    const db = 20 * Math.log10(value);
    return Math.min(1, Math.max(0, (db + 60) / 60));
};
/** Tracks how long a channel has been continuously silent. */
export class SilenceTracker {
    silentSince = null;
    thresholdMs;
    constructor(thresholdMs = SILENCE_WARN_MS) {
        this.thresholdMs = thresholdMs;
    }
    /** Returns true once the channel has been silent for the threshold. */
    update(level, nowMs) {
        if (level >= SILENCE_RMS) {
            this.silentSince = null;
            return false;
        }
        this.silentSince ??= nowMs;
        return nowMs - this.silentSince >= this.thresholdMs;
    }
    reset() {
        this.silentSince = null;
    }
}
/**
 * Polls both analysers every `intervalMs` and reports levels. Returns
 * a stop function. setInterval rather than requestAnimationFrame: the
 * offscreen document is never visible, and rAF does not run there.
 */
export const monitorLevels = (source, onLevels, intervalMs = 250, now = () => Date.now()) => {
    const micTracker = new SilenceTracker();
    const tabTracker = new SilenceTracker();
    const leftBuf = new Float32Array(source.left.fftSize);
    const rightBuf = new Float32Array(source.right.fftSize);
    const tick = () => {
        source.left.getFloatTimeDomainData(leftBuf);
        source.right.getFloatTimeDomainData(rightBuf);
        const micRms = rms(leftBuf);
        const tabRms = rms(rightBuf);
        const at = now();
        const micOn = source.isMicEnabled();
        // A mic the user switched off is silent on purpose.
        if (!micOn)
            micTracker.reset();
        onLevels({
            mic: {
                level: meterLevel(micRms),
                silent: micOn ? micTracker.update(micRms, at) : false,
            },
            tab: { level: meterLevel(tabRms), silent: tabTracker.update(tabRms, at) },
        });
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
};
