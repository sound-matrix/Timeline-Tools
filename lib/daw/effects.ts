import type { PluginSlot } from "../arrangement.ts";
export const EFFECTS = {
  eq: {
    name: "Shape EQ",
    params: Object.fromEntries(
      [80, 300, 1000, 3500, 10000].flatMap((f, i) => [
        [`f${i}`, [f, 20, 20000, 1]],
        [`g${i}`, [0, -24, 24, 0.1]],
        [`q${i}`, [1, 0.1, 12, 0.1]],
      ]),
    ),
  },
  compressor: {
    name: "Squeeze",
    params: {
      threshold: [-24, -60, 0, 0.1],
      ratio: [4, 1, 20, 0.1],
      attack: [0.01, 0.001, 1, 0.001],
      release: [0.2, 0.01, 2, 0.01],
      knee: [12, 0, 40, 1],
      makeup: [0, 0, 24, 0.1],
    },
  },
  limiter: {
    name: "Ceiling",
    params: { threshold: [-1, -12, 0, 0.1], release: [0.08, 0.01, 1, 0.01] },
  },
  reverb: {
    name: "Space",
    params: { decay: [1.2, 0.1, 3, 0.1], mix: [0.2, 0, 1, 0.01] },
  },
  delay: {
    name: "Echo",
    params: {
      beats: [0.5, 0.125, 4, 0.125],
      feedback: [0.3, 0, 0.85, 0.01],
      mix: [0.2, 0, 1, 0.01],
    },
  },
  saturation: {
    name: "Warmth",
    params: { drive: [2, 1, 16, 0.1], mix: [0.5, 0, 1, 0.01] },
  },
  gate: { name: "Quiet", params: { threshold: [-40, -80, -6, 1] } },
  deesser: {
    name: "Silk",
    params: { frequency: [6000, 2000, 12000, 100], reduction: [6, 0, 18, 0.1] },
  },
} as const;
export type EffectType = keyof typeof EFFECTS;
export function effectDefaults(type: EffectType): Record<string, number> {
  return Object.fromEntries(
    Object.entries(EFFECTS[type].params).map(([k, v]) => [k, v[0]]),
  );
}
export function effectPresets(
  type: EffectType,
): { name: string; parameters: Record<string, number> }[] {
  const presets: Record<EffectType, [string, Record<string, number>][]> = {
    eq: [
      ["Flat", {}],
      ["Vocal focus", { g0: -4, g1: -2, g3: 3 }],
      ["Air", { g4: 5, q4: 0.7 }],
    ],
    compressor: [
      ["Balanced", {}],
      ["Soft", { threshold: -18, ratio: 2, knee: 20 }],
      ["Firm", { threshold: -30, ratio: 8, attack: 0.003 }],
    ],
    limiter: [
      ["Gentle ceiling", {}],
      ["Broadcast", { threshold: -3, release: 0.15 }],
    ],
    reverb: [
      ["Small", { decay: 0.4, mix: 0.15 }],
      ["Room", {}],
      ["Hall", { decay: 2.8, mix: 0.35 }],
    ],
    delay: [
      ["Eighth", {}],
      ["Quarter", { beats: 1, feedback: 0.4, mix: 0.25 }],
      ["Dotted", { beats: 0.75, feedback: 0.35 }],
    ],
    saturation: [
      ["Balanced", {}],
      ["Soft", { drive: 1.5, mix: 0.3 }],
      ["Grit", { drive: 8, mix: 0.7 }],
    ],
    gate: [
      ["Voice", {}],
      ["Gentle", { threshold: -55 }],
      ["Firm", { threshold: -25 }],
    ],
    deesser: [
      ["Balanced", {}],
      ["Gentle", { reduction: 3 }],
      ["Bright sibilance", { frequency: 8000, reduction: 10 }],
    ],
  };
  return presets[type].map(([name, p]) => ({
    name,
    parameters: { ...effectDefaults(type), ...p },
  }));
}
export function validEffect(type: EffectType, params: Record<string, number>) {
  const spec = EFFECTS[type]?.params as
    Record<string, readonly number[]> | undefined;
  return (
    !!spec &&
    Object.keys(params).length === Object.keys(spec).length &&
    Object.entries(spec).every(
      ([k, v]) =>
        Number.isFinite(params[k]) && params[k] >= v[1] && params[k] <= v[2],
    )
  );
}
export function newEffect(type: EffectType): PluginSlot {
  return {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    parameters: effectDefaults(type),
  };
}
export type EffectGraph = {
  input: GainNode;
  output: GainNode;
  nodes: AudioNode[];
  analyser: AnalyserNode;
  compressors: DynamicsCompressorNode[];
  reductions: Map<string, DynamicsCompressorNode>;
  dispose: () => void;
};
const preparedContexts = new WeakMap<BaseAudioContext, Promise<void>>();
/** Register once per live/offline context before constructing insert graphs. */
export function prepareEffectContext(ctx: BaseAudioContext): Promise<void> {
  let ready = preparedContexts.get(ctx);
  if (!ready) {
    ready = ctx.audioWorklet.addModule("/daw/delay-processor.js");
    preparedContexts.set(ctx, ready);
    ready.catch(() => preparedContexts.delete(ctx));
  }
  return ready;
}
/** Identical topology for live playback and OfflineAudioContext exports. */
export function createEffectChain(
  ctx: BaseAudioContext,
  slots: PluginSlot[],
  tempo: number,
): EffectGraph {
  const reductions = new Map<string, DynamicsCompressorNode>();
  const nodes: AudioNode[] = [],
    compressors: DynamicsCompressorNode[] = [];
  const gain = (value = 1) => {
    const n = ctx.createGain();
    n.gain.value = value;
    nodes.push(n);
    return n;
  };
  const input = gain(),
    output = gain();
  let last: AudioNode = input;
  for (const slot of slots) {
    if (!slot.enabled) continue;
    const p = slot.parameters,
      start = gain();
    last.connect(start);
    if (slot.type === "eq") {
      let at: AudioNode = start;
      for (let i = 0; i < 5; i++) {
        const n = ctx.createBiquadFilter();
        n.type = "peaking";
        n.frequency.value = Math.min(p[`f${i}`], ctx.sampleRate * 0.49);
        n.Q.value = p[`q${i}`];
        n.gain.value = p[`g${i}`];
        nodes.push(n);
        at.connect(n);
        at = n;
      }
      last = at;
    } else if (slot.type === "compressor" || slot.type === "limiter") {
      const n = ctx.createDynamicsCompressor(),
        makeup = gain(10 ** ((p.makeup ?? 0) / 20));
      n.threshold.value = p.threshold;
      n.ratio.value = p.ratio ?? 20;
      n.attack.value = p.attack ?? 0.001;
      n.release.value = p.release;
      n.knee.value = p.knee ?? 0;
      start.connect(n).connect(makeup);
      nodes.push(n);
      compressors.push(n);
      reductions.set(slot.id, n);
      last = makeup;
      if (slot.type === "limiter") {
        const ceiling = ctx.createWaveShaper(),
          curve = new Float32Array(65537),
          limit = 10 ** (p.threshold / 20);
        for (let i = 0; i < curve.length; i++)
          curve[i] = Math.max(
            -limit,
            Math.min(limit, (2 * i) / (curve.length - 1) - 1),
          );
        ceiling.curve = curve;
        makeup.connect(ceiling);
        nodes.push(ceiling);
        last = ceiling;
      }
    } else if (slot.type === "deesser") {
      const n = ctx.createBiquadFilter();
      n.type = "highshelf";
      n.frequency.value = p.frequency;
      n.gain.value = -p.reduction;
      start.connect(n);
      nodes.push(n);
      last = n;
    } else if (slot.type === "gate" || slot.type === "saturation") {
      const n = ctx.createWaveShaper(),
        curve = new Float32Array(65537),
        threshold = 10 ** (p.threshold / 20);
      for (let i = 0; i < curve.length; i++) {
        const x = (2 * i) / (curve.length - 1) - 1;
        curve[i] =
          slot.type === "gate"
            ? Math.abs(x) < threshold
              ? 0
              : x
            : x * (1 - p.mix) +
              (p.mix * Math.tanh(x * p.drive)) / Math.tanh(p.drive);
      }
      n.curve = curve;
      start.connect(n);
      nodes.push(n);
      last = n;
    } else {
      const dry = gain(1 - p.mix),
        wet = gain(p.mix),
        sum = gain();
      start.connect(dry).connect(sum);
      wet.connect(sum);
      if (slot.type === "delay") {
        // Native feedback cycles differ by a render quantum between engines.
        // Keep the same sample recurrence as the stateful Python export chain.
        const n = new AudioWorkletNode(ctx, "timeline-echo", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: "explicit",
          processorOptions: {
            delayFrames: Math.max(
              1,
              Math.round((60 / tempo) * p.beats * ctx.sampleRate),
            ),
            feedback: p.feedback,
          },
        });
        start.connect(n).connect(wet);
        nodes.push(n);
      } else {
        const n = ctx.createConvolver(),
          count = Math.ceil(ctx.sampleRate * p.decay),
          b = ctx.createBuffer(2, count, ctx.sampleRate);
        // Deterministic sparse room impulse; exactly reproducible in scipy.
        for (let ch = 0; ch < 2; ch++) {
          const d = b.getChannelData(ch);
          for (let j = 1; j <= 32; j++) {
            const at = Math.min(count - 1, Math.round((count * j) / 33));
            d[at] = (Math.exp((-3 * j) / 33) * (j % 2 ? -1 : 1)) / 8;
          }
        }
        n.normalize = false;
        n.buffer = b;
        start.connect(n).connect(wet);
        nodes.push(n);
      }
      last = sum;
    }
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  nodes.push(analyser);
  last.connect(analyser).connect(output);
  return {
    input,
    output,
    nodes,
    analyser,
    compressors,
    reductions,
    dispose: () =>
      nodes.forEach((n) => {
        if (
          typeof AudioWorkletNode !== "undefined" &&
          n instanceof AudioWorkletNode
        )
          n.port.postMessage("dispose");
        n.disconnect();
      }),
  };
}
