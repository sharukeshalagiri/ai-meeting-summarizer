// GENERATED from frontend/src/lib/capture/stereoMix.ts by
// extension/scripts/build-capture.mjs. Do not edit; edit the source.
/**
 * Builds the contract's stereo layout from two streams:
 * LEFT = the user's microphone, RIGHT = the meeting (tab audio).
 *
 *   mic  -> micGain  --+--> merger input 0 (left)  --> destination stream
 *   tab  -> tabGain  --+--> merger input 1 (right) -/
 *   micGain -> leftAnalyser, tabGain -> rightAnalyser (level meters)
 *   tab  -> ctx.destination (optional playback, see below)
 *
 * A ChannelMergerNode input is mono (channelCount 1, explicit), so a
 * stereo tab is down-mixed to the right channel and a stereo mic to the
 * left by the Web Audio "speakers" rules; no extra nodes are needed.
 *
 * Only the minimal AudioContext surface is used so tests can pass a fake.
 */
/** Which merger input carries which source. Tests assert on these. */
export const MIC_INPUT = 0;
export const TAB_INPUT = 1;
export const buildStereoMix = (ctx, options) => {
    const merger = ctx.createChannelMerger(2);
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 2;
    const micGain = ctx.createGain();
    const tabGain = ctx.createGain();
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    left.fftSize = 2048;
    right.fftSize = 2048;
    const tabSource = ctx.createMediaStreamSource(options.tab);
    tabSource.connect(tabGain);
    tabGain.connect(merger, 0, TAB_INPUT);
    tabGain.connect(right);
    const hasMic = Boolean(options.mic && options.mic.getAudioTracks().length);
    const micSource = hasMic && options.mic
        ? ctx.createMediaStreamSource(options.mic)
        : null;
    // micGain is always wired so the left input exists (silence when there
    // is no mic) and the recorded file is stereo either way.
    micSource?.connect(micGain);
    micGain.connect(merger, 0, MIC_INPUT);
    micGain.connect(left);
    merger.connect(destination);
    if (options.playTab)
        tabSource.connect(ctx.destination);
    let micEnabled = hasMic;
    micGain.gain.value = micEnabled ? 1 : 0;
    return {
        stream: destination.stream,
        left,
        right,
        hasMic,
        setMicEnabled(enabled) {
            // Gain rather than track.enabled: the left channel must keep
            // existing (as silence) so the layout never changes mid-chunk.
            micEnabled = enabled && hasMic;
            micGain.gain.value = micEnabled ? 1 : 0;
        },
        isMicEnabled: () => micEnabled,
        disconnect() {
            for (const node of [tabSource, micSource, tabGain, micGain, merger]) {
                node?.disconnect();
            }
        },
    };
};
