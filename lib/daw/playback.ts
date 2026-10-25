import {
  createEffectChain,
  prepareEffectContext,
  type EffectGraph,
} from "./effects.ts";
import type { Arrangement } from "../arrangement";
import { pcmWindow } from "../studio-preview";
import {
  SCHEDULER_INTERVAL_MS,
  SCHEDULER_LOOKAHEAD_SECONDS,
  STREAM_CHUNK_SECONDS,
  schedulerChunks,
  changedRegions,
} from "./scheduler.ts";
import { end, fadeValue, panGains } from "./commands";
import { outputClockTime, PresentationClock } from "./output-clock.ts";
/** Bounded PCM streaming: sample scheduling uses the AudioContext clock, never timers. */
function releaseVoice(param: AudioParam, now: number) {
  const value = param.value;
  // This parameter belongs to a separate release node, never the fade curve.
  param.cancelScheduledValues(0);
  param.setValueAtTime(value, now);
  param.setTargetAtTime(0, now, 0.001);
}
export class DawPlayback {
  tempo = 120;
  regionInputs = new Map<string, GainNode>();
  derived: Arrangement["derived_clips"] = [];
  reader:
    | ((
        ctx: AudioContext,
        url: string,
        start: number,
        length: number,
      ) => Promise<AudioBuffer>)
    | undefined;
  dispose: (() => void) | null = null;
  sourceUrls: Record<string, string> = {};
  context: AudioContext | null = null;
  sources = new Set<AudioBufferSourceNode>();
  meters: AnalyserNode[] = [];
  buffers = new Map<string, AudioBuffer>();
  epoch = 0;
  frame = 0;
  analyser: AnalyserNode | null = null;
  origin = 0;
  running = false;
  async window(url: string, start: number, length: number) {
    const ctx = (this.context ??= new AudioContext());
    const derived = this.derived.find((c) => c.id === url);
    const key = `${url}/${start}/${length}`;
    const cached = this.buffers.get(key);
    if (cached) return cached;
    let b: AudioBuffer;
    if (derived) {
      const sourceUrl = this.sourceUrls[derived.source];
      if (!sourceUrl) throw Error("Bounce source unavailable");
      const renderStart = derived.inserts?.some((s) => s.enabled)
          ? Math.max(0, start - 60)
          : start,
        preroll = start - renderStart;
      const input = await (this.reader ?? pcmWindow)(
        ctx,
        sourceUrl,
        derived.reverse
          ? derived.src_end - renderStart - length - preroll
          : derived.src_start + renderStart,
        length + preroll,
      );
      const offline = new OfflineAudioContext(
          2,
          input.length,
          input.sampleRate,
        ),
        source = offline.createBufferSource(),
        gain = offline.createGain();
      if (derived.reverse) {
        const copy = offline.createBuffer(
          input.numberOfChannels,
          input.length,
          input.sampleRate,
        );
        for (let c = 0; c < input.numberOfChannels; c++)
          copy.getChannelData(c).set(input.getChannelData(c).slice().reverse());
        source.buffer = copy;
      } else source.buffer = input;
      const values = new Float32Array(input.length);
      for (let i = 0; i < values.length; i++)
        values[i] =
          10 ** (derived.gain_db / 20) *
          fadeValue(
            { ...derived, src_start: 0, src_end: derived.duration },
            renderStart + i / input.sampleRate,
          );
      gain.gain.setValueCurveAtTime(values, 0, input.duration);
      await prepareEffectContext(offline);
      const fx = createEffectChain(
        offline,
        derived.inserts ?? [],
        this.active?.tempo ?? this.tempo,
      );
      source.connect(gain).connect(fx.input);
      fx.output.connect(offline.destination);
      source.start();
      b = await offline.startRendering();
      if (preroll) {
        const cropped = ctx.createBuffer(
          b.numberOfChannels,
          Math.round(length * b.sampleRate),
          b.sampleRate,
        );
        for (let c = 0; c < b.numberOfChannels; c++)
          cropped
            .getChannelData(c)
            .set(
              b
                .getChannelData(c)
                .subarray(
                  Math.round(preroll * b.sampleRate),
                  Math.round((preroll + length) * b.sampleRate),
                ),
            );
        b = cropped;
      }
    } else b = await (this.reader ?? pcmWindow)(ctx, url, start, length);
    this.buffers.set(key, b);
    if (this.buffers.size > 64)
      this.buffers.delete(this.buffers.keys().next().value!);
    return b;
  }
  async regionWindow(
    r: Arrangement["regions"][number],
    offset: number,
    length: number,
  ) {
    const at = r.reverse ? r.src_end - offset - length : r.src_start + offset;
    const b = await this.window(this.urlMap[r.clip] ?? r.clip, at, length);
    if (!r.reverse) return b;
    const out = this.context!.createBuffer(
      b.numberOfChannels,
      b.length,
      b.sampleRate,
    );
    for (let c = 0; c < b.numberOfChannels; c++)
      out.getChannelData(c).set(b.getChannelData(c).slice().reverse());
    return out;
  }
  stop() {
    this.running = false;
    this.epoch++;
    cancelAnimationFrame(this.frame);
    this.clock?.terminate();
    this.clock = null;
    this.tickNow = null;
    const now = this.context?.currentTime ?? 0;
    for (const source of this.sources) {
      const voice = this.voices.get(source);
      if (voice) {
        releaseVoice(voice.gain.gain, now);
      }
      try {
        source.stop(now + 0.005);
      } catch {}
    }
    this.sources.clear();
    this.voices.clear();
    const old = this.nodes,
      graphs = [...this.effects.values()];
    this.nodes = [];
    setTimeout(() => {
      graphs.forEach((g) => g.graph.dispose());
      old.forEach((n) => {
        try {
          n.disconnect();
        } catch {}
      });
    }, 10);
    this.dispose?.();
    this.dispose = null;
    this.effects.clear();
    this.regionInputs.clear();
    this.active = null;
  }
  async close() {
    this.stop();
    await this.context?.close();
  }
  clock: Worker | null = null;
  active: Arrangement | null = null;
  urlMap: Record<string, string> = {};
  changed = new Map<string, number>();
  voices = new Map<AudioBufferSourceNode, { region: string; gain: GainNode }>();
  scheduled = new Set<string>();
  tracks = new Map<
    string,
    { gain: GainNode; left: GainNode; right: GainNode; insert: GainNode }
  >();
  effects = new Map<
    string,
    { key: string; graph: EffectGraph; output: AudioNode }
  >();
  master: GainNode | null = null;
  masterInput: GainNode | null = null;
  effectGraph(
    id: string,
    slots: Arrangement["master"]["inserts"],
    tempo: number,
    input: AudioNode,
    output: AudioNode,
  ) {
    const key = JSON.stringify([
        slots.map(({ id, type, enabled }) => [id, type, enabled]),
        tempo,
      ]),
      old = this.effects.get(id);
    if (old?.key === key) {
      old.graph.update(slots);
      if (old.output !== output) {
        old.graph.output.disconnect();
        old.graph.output.connect(output);
        old.output = output;
      }
      return;
    }
    input.disconnect();
    old?.graph.dispose();
    const graph = createEffectChain(this.context!, slots, tempo);
    input.connect(graph.input);
    graph.output.connect(output);
    this.effects.set(id, { key, graph, output });
  }
  nodes: AudioNode[] = [];
  tickNow: (() => void) | null = null;
  /** Track insert entry point, also used by metering and the effects dock. */
  insertChain(trackId: string): GainNode | undefined {
    return this.tracks.get(trackId)?.insert;
  }
  update(a: Arrangement, urls = this.urlMap) {
    const ctx = this.context;
    if (!ctx || !this.active) return;
    for (const id of changedRegions(this.active, a)) {
      this.changed.set(id, (this.changed.get(id) ?? 0) + 1);
      for (const key of this.scheduled)
        if (key.startsWith(id + "/")) this.scheduled.delete(key);
      for (const [source, v] of this.voices)
        if (v.region === id) {
          releaseVoice(v.gain.gain, ctx.currentTime);
          try {
            source.stop(ctx.currentTime + 0.005);
          } catch {}
        }
    }
    this.active = a;
    this.derived = a.derived_clips;
    this.sourceUrls = urls;
    this.urlMap = urls;
    const solo = a.lanes.some((l) => l.solo);
    for (const lane of a.lanes) {
      let track = this.tracks.get(lane.id);
      if (!track) {
        const gain = ctx.createGain(),
          split = ctx.createChannelSplitter(2),
          merge = ctx.createChannelMerger(2),
          left = ctx.createGain(),
          right = ctx.createGain(),
          insert = ctx.createGain();
        gain.channelCount = 2;
        gain.channelCountMode = "explicit";
        gain.connect(split);
        split.connect(left, 0);
        split.connect(right, 1);
        left.connect(merge, 0, 0);
        right.connect(merge, 0, 1);
        merge.connect(this.masterInput!);
        track = { gain, left, right, insert };
        this.tracks.set(lane.id, track);
        this.nodes.push(gain, split, merge, left, right, insert);
      }
      this.effectGraph(
        lane.id,
        lane.inserts,
        a.tempo,
        track.insert,
        track.gain,
      );
      track.gain.gain.setTargetAtTime(
        lane.mute || (solo && !lane.solo) ? 0 : 10 ** (lane.gain_db / 20),
        ctx.currentTime,
        0.005,
      );
      const pan = panGains(lane.pan, a.pan_law);
      track.left.gain.setTargetAtTime(pan[0], ctx.currentTime, 0.005);
      track.right.gain.setTargetAtTime(pan[1], ctx.currentTime, 0.005);
    }
    for (const [id, track] of this.tracks)
      if (!a.lanes.some((l) => l.id === id))
        track.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.001);
    this.effectGraph(
      "master",
      a.master.inserts,
      a.tempo,
      this.masterInput!,
      this.master!,
    );
    for (const r of a.regions) {
      if (!this.tracks.has(r.lane)) continue;
      let input = this.regionInputs.get(r.id);
      if (!input) {
        input = ctx.createGain();
        this.regionInputs.set(r.id, input);
        this.nodes.push(input);
      }
      this.effectGraph(
        `region/${r.id}`,
        r.inserts ?? [],
        a.tempo,
        input,
        this.tracks.get(r.lane)!.insert,
      );
    }
    for (const [key, value] of this.effects) {
      if (
        key.startsWith("region/") &&
        !a.regions.some((r) => `region/${r.id}` === key)
      ) {
        value.graph.dispose();
        this.effects.delete(key);
        const input = this.regionInputs.get(key.slice(7));
        input?.disconnect();
        this.regionInputs.delete(key.slice(7));
      }
    }
    this.masterInput!.gain.setTargetAtTime(
      10 ** ((a.master.gain_db + (a.master.reference_gain_db ?? 0)) / 20),
      ctx.currentTime,
      0.005,
    );
    this.tickNow?.();
  }
  async play(
    a: Arrangement,
    position: number,
    urls: Record<string, string>,
    tick: (t: number, presenting?: boolean) => void,
    finish: () => void,
  ) {
    this.stop();
    if (this.context && this.context.sampleRate !== a.sample_rate) {
      await this.context.close();
      this.context = null;
    }
    const epoch = this.epoch,
      ctx = (this.context ??= new AudioContext({ sampleRate: a.sample_rate }));
    await Promise.all([ctx.resume(), prepareEffectContext(ctx)]);
    if (epoch !== this.epoch) return;
    this.derived = a.derived_clips;
    this.sourceUrls = urls;
    this.urlMap = urls;
    const master = ctx.createGain(),
      analyser = ctx.createAnalyser(),
      split = ctx.createChannelSplitter(2);
    analyser.fftSize = 1024;
    master.connect(analyser).connect(ctx.destination);
    master.connect(split);
    this.master = master;
    this.masterInput = ctx.createGain();
    this.analyser = analyser;
    this.meters = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.meters.forEach((m, i) => {
      m.fftSize = 1024;
      split.connect(m, i);
    });
    this.nodes = [this.masterInput!, master, analyser, split, ...this.meters];
    this.tracks.clear();
    this.scheduled.clear();
    this.voices.clear();
    this.changed.clear();
    this.active = a;
    this.update(a, urls);
    const loading = new Map<string, Promise<AudioBuffer>>();
    let cycle = 0;
    const read = (r: Arrangement["regions"][number], chunk: number) => {
      const url = this.urlMap[r.clip] ?? r.clip,
        offset = chunk * STREAM_CHUNK_SECONDS,
        length = Math.min(
          STREAM_CHUNK_SECONDS,
          r.src_end - r.src_start - offset,
        ),
        key = `${url}/${r.src_start + offset}/${length}/${r.reverse}`;
      let promise = loading.get(key);
      if (!promise) {
        promise = this.regionWindow(r, offset, length);
        loading.set(key, promise);
        promise.finally(() => loading.delete(key)).catch(() => {});
      }
      return promise;
    };
    const schedule = async (
      now: number,
      origin: number,
      iteration: number,
      preload = false,
    ) => {
      const current = this.active!;
      const tasks: Promise<void>[] = [];
      for (const r of current.regions) {
        if (r.mute || !this.tracks.has(r.lane)) continue;
        for (const chunk of schedulerChunks(
          r.start,
          r.src_end - r.src_start,
          now,
        )) {
          const key = `${r.id}/${iteration}/${chunk}`,
            at = r.start + chunk * STREAM_CHUNK_SECONDS;
          if (this.scheduled.has(key)) continue;
          if (!preload && at > now + SCHEDULER_LOOKAHEAD_SECONDS) {
            void read(r, chunk).catch(() => {});
            continue;
          }
          const version = this.changed.get(r.id) ?? 0;
          if (!preload) this.scheduled.add(key);
          tasks.push(
            (async () => {
              const buffer = await read(r, chunk);
              if (
                preload ||
                epoch !== this.epoch ||
                (this.changed.get(r.id) ?? 0) !== version
              )
                return;
              const late = Math.max(0, ctx.currentTime - origin - at, now - at),
                from = chunk * STREAM_CHUNK_SECONDS + late;
              const when = Math.max(
                  ctx.currentTime + 0.001,
                  origin + at + late,
                ),
                limit = current.loop.enabled
                  ? current.loop.end
                  : current.duration;
              const duration = Math.min(
                buffer.duration - late,
                limit - at - late,
              );
              if (duration <= 0) return;
              const source = ctx.createBufferSource(),
                gain = ctx.createGain(),
                release = ctx.createGain();
              source.buffer = buffer;
              source
                .connect(gain)
                .connect(release)
                .connect(
                  this.regionInputs.get(r.id) ??
                    this.tracks.get(r.lane)!.insert,
                );
              const points = [
                ...new Set(
                  [
                    from,
                    from + duration,
                    r.fade_in,
                    r.src_end - r.src_start - r.fade_out,
                  ].filter((t) => t >= from && t <= from + duration),
                ),
              ].sort((a, b) => a - b);
              for (let segment = 0; segment < points.length - 1; segment++) {
                const begin = points[segment],
                  length = points[segment + 1] - begin;
                if (length <= 0) continue;
                const curve = new Float32Array(
                  Math.max(
                    2,
                    Math.min(4096, Math.ceil(length * ctx.sampleRate)),
                  ),
                );
                for (let i = 0; i < curve.length; i++)
                  curve[i] =
                    10 ** (r.gain_db / 20) *
                    fadeValue(r, begin + (length * i) / (curve.length - 1));
                gain.gain.setValueCurveAtTime(
                  curve,
                  when + begin - from,
                  length,
                );
              }
              source.onended = () => {
                source.disconnect();
                gain.disconnect();
                release.disconnect();
                this.sources.delete(source);
                this.voices.delete(source);
              };
              source.start(when, late, duration);
              this.sources.add(source);
              this.voices.set(source, { region: r.id, gain: release });
            })(),
          );
        }
      }
      await Promise.all(tasks);
    };
    try {
      await schedule(position, 0, 0, true);
      if (epoch !== this.epoch) return;
      this.origin = ctx.currentTime + 0.04 - position;
      const initialOrigin = this.origin;
      this.running = true;
      // Resolve play only once the initial sources are scheduled, not on a later timer turn.
      await schedule(position, this.origin, 0);
      if (epoch !== this.epoch) return;
      const fail = () => {
        if (epoch === this.epoch) {
          this.stop();
          finish();
        }
      };
      const clock = () => {
        if (epoch !== this.epoch || !this.active) return;
        const current = this.active;
        let now = Math.max(
          cycle === 0 ? position : current.loop.start,
          ctx.currentTime - this.origin,
        );
        if (current.loop.enabled && now >= current.loop.end) {
          this.origin += current.loop.end - current.loop.start;
          cycle++;
          now = ctx.currentTime - this.origin;
        }
        if (!current.loop.enabled && now >= current.duration) {
          if (outputClockTime(ctx) - initialOrigin < current.duration) return;
          tick(current.duration);
          this.stop();
          finish();
          return;
        }
        void schedule(now, this.origin, cycle).catch(fail);
        if (
          current.loop.enabled &&
          now + SCHEDULER_LOOKAHEAD_SECONDS >= current.loop.end
        )
          void schedule(
            current.loop.start,
            this.origin + current.loop.end - current.loop.start,
            cycle + 1,
          ).catch(fail);
      };
      this.tickNow = clock;
      clock();
      if (typeof Worker !== "undefined") {
        this.clock = new Worker("/daw/clock-worker.js");
        this.clock.onmessage = clock;
        this.clock.postMessage({
          running: true,
          interval: SCHEDULER_INTERVAL_MS,
        });
      } else {
        const timer = setInterval(clock, SCHEDULER_INTERVAL_MS);
        this.dispose = () => clearInterval(timer);
      }
      const presentation = new PresentationClock();
      const draw = () => {
        if (epoch !== this.epoch || !this.active) return;
        const current = this.active;
        const sample = presentation.sample(ctx),
          heard = sample.time;
        let time = heard - initialOrigin;
        if (cycle > 0 && current.loop.enabled && time >= current.loop.end) {
          const length = current.loop.end - current.loop.start;
          time =
            current.loop.start +
            ((((heard - this.origin - current.loop.start) % length) + length) %
              length);
        }
        tick(
          Math.max(cycle === 0 ? position : current.loop.start, time),
          sample.advancing && (cycle > 0 || heard - initialOrigin >= position),
        );
        this.frame = requestAnimationFrame(draw);
      };
      this.frame = requestAnimationFrame(draw);
    } catch (error) {
      this.stop();
      throw error;
    }
  }
}
