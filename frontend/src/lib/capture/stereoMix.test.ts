import { describe, expect, it } from "vitest";
import { MIC_INPUT, TAB_INPUT, buildStereoMix, type MixContext } from "./stereoMix.ts";

/** Records every connect() so the graph can be asserted without Web Audio. */
interface FakeNode {
  kind: string;
  label?: string;
  connections: { target: FakeNode; output?: number; input?: number }[];
  gain?: { value: number };
  channelCount?: number;
  fftSize?: number;
  stream?: unknown;
  connect(target: FakeNode, output?: number, input?: number): void;
  disconnect(): void;
}

const node = (kind: string, extra: Partial<FakeNode> = {}): FakeNode => {
  const n: FakeNode = {
    kind,
    connections: [],
    connect(target, output, input) {
      n.connections.push({ target, output, input });
    },
    disconnect() {
      n.connections = [];
    },
    ...extra,
  };
  return n;
};

const fakeStream = (label: string, tracks = 1) =>
  ({ label, getAudioTracks: () => Array.from({ length: tracks }) }) as unknown as MediaStream;

const fakeContext = () => {
  const created: FakeNode[] = [];
  const make = (kind: string, extra: Partial<FakeNode> = {}) => {
    const n = node(kind, extra);
    created.push(n);
    return n;
  };
  const destination = node("speakers");

  const ctx = {
    destination,
    createChannelMerger: (inputs: number) => make("merger", { channelCount: inputs }),
    createMediaStreamDestination: () => make("recordDest", { stream: "stereo-stream" }),
    createMediaStreamSource: (stream: MediaStream) =>
      make("source", { label: (stream as unknown as { label: string }).label }),
    createGain: () => make("gain", { gain: { value: 1 } }),
    createAnalyser: () => make("analyser", { fftSize: 0 }),
  } as unknown as MixContext;

  return { ctx, created, destination };
};

/** The merger input that `sourceLabel` reaches through its gain node. */
const mergerInputOf = (created: FakeNode[], sourceLabel: string) => {
  const source = created.find((n) => n.kind === "source" && n.label === sourceLabel)!;
  const gain = source.connections.find((c) => c.target.kind === "gain")!.target;
  const toMerger = gain.connections.find((c) => c.target.kind === "merger")!;
  return { gain, input: toMerger.input };
};

describe("buildStereoMix channel layout", () => {
  it("puts the mic on the left (input 0) and the tab on the right (input 1)", () => {
    const { ctx, created } = fakeContext();

    const mix = buildStereoMix(ctx, { mic: fakeStream("mic"), tab: fakeStream("tab") });

    expect(MIC_INPUT).toBe(0);
    expect(TAB_INPUT).toBe(1);
    expect(mergerInputOf(created, "mic").input).toBe(0);
    expect(mergerInputOf(created, "tab").input).toBe(1);

    const merger = created.find((n) => n.kind === "merger")!;
    expect(merger.channelCount).toBe(2);
    expect(merger.connections[0].target.kind).toBe("recordDest");
    expect(mix.stream).toBe("stereo-stream");
  });

  it("meters each channel separately", () => {
    const { ctx, created } = fakeContext();
    const mix = buildStereoMix(ctx, { mic: fakeStream("mic"), tab: fakeStream("tab") });

    const micGain = mergerInputOf(created, "mic").gain;
    const tabGain = mergerInputOf(created, "tab").gain;

    expect(micGain.connections.map((c) => c.target)).toContain(mix.left);
    expect(tabGain.connections.map((c) => c.target)).toContain(mix.right);
    expect(mix.left).not.toBe(mix.right);
  });

  it("mic toggle silences only the left channel", () => {
    const { ctx, created } = fakeContext();
    const mix = buildStereoMix(ctx, { mic: fakeStream("mic"), tab: fakeStream("tab") });
    const micGain = mergerInputOf(created, "mic").gain;
    const tabGain = mergerInputOf(created, "tab").gain;

    mix.setMicEnabled(false);
    expect(micGain.gain!.value).toBe(0);
    expect(tabGain.gain!.value).toBe(1);
    expect(mix.isMicEnabled()).toBe(false);

    mix.setMicEnabled(true);
    expect(micGain.gain!.value).toBe(1);
  });

  it("stays stereo with a silent left channel when there is no mic", () => {
    const { ctx, created } = fakeContext();
    const mix = buildStereoMix(ctx, { mic: null, tab: fakeStream("tab") });

    const gains = created.filter((n) => n.kind === "gain");
    const leftGain = gains.find((g) =>
      g.connections.some((c) => c.target.kind === "merger" && c.input === MIC_INPUT)
    )!;

    expect(leftGain.gain!.value).toBe(0);
    expect(mix.hasMic).toBe(false);
    mix.setMicEnabled(true);
    expect(leftGain.gain!.value).toBe(0);
  });

  it("plays the tab back only when asked (tabCapture mutes the tab)", () => {
    const withPlayback = fakeContext();
    buildStereoMix(withPlayback.ctx, { mic: null, tab: fakeStream("tab"), playTab: true });
    const tabSource = withPlayback.created.find((n) => n.label === "tab")!;
    expect(tabSource.connections.map((c) => c.target)).toContain(withPlayback.destination);

    const without = fakeContext();
    buildStereoMix(without.ctx, { mic: null, tab: fakeStream("tab") });
    const quietSource = without.created.find((n) => n.label === "tab")!;
    expect(quietSource.connections.map((c) => c.target)).not.toContain(without.destination);
  });
});
