import type { Arrangement } from "../arrangement";
import { pcmWindow } from "../studio-preview";
import { end, fadeValue, panGains } from "./commands";
/** Bounded PCM streaming: sample scheduling uses the AudioContext clock, never timers. */
export class DawPlayback {
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
      const input = await pcmWindow(
        ctx,
        sourceUrl,
        derived.src_start + start,
        length,
      );
      const offline = new OfflineAudioContext(
          2,
          input.length,
          input.sampleRate,
        ),
        source = offline.createBufferSource(),
        gain = offline.createGain();
      source.buffer = input;
      const values = new Float32Array(input.length);
      for (let i = 0; i < values.length; i++)
        values[i] =
          10 ** (derived.gain_db / 20) *
          fadeValue(
            { ...derived, src_start: 0, src_end: derived.duration },
            start + i / input.sampleRate,
          );
      gain.gain.setValueCurveAtTime(values, 0, input.duration);
      source.connect(gain).connect(offline.destination);
      source.start();
      b = await offline.startRendering();
    } else b = await (this.reader ?? pcmWindow)(ctx, url, start, length);
    this.buffers.set(key, b);
    if (this.buffers.size > 64)
      this.buffers.delete(this.buffers.keys().next().value!);
    return b;
  }
  stop() {
    this.running = false;
    this.epoch++;
    cancelAnimationFrame(this.frame);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.dispose?.();
    this.dispose = null;
  }
  async close() {
    this.stop();
    await this.context?.close();
  }
  async play(
    a: Arrangement,
    position: number,
    urls: Record<string, string>,
    tick: (t: number) => void,
    finish: () => void,
  ) {
    this.stop();
    this.derived = a.derived_clips;
    this.sourceUrls = urls;
    const epoch = this.epoch,
      ctx = (this.context ??= new AudioContext());
    await ctx.resume();
    const master = ctx.createGain();
    master.gain.value =
      10 ** ((a.master.gain_db + (a.master.reference_gain_db ?? 0)) / 20);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    master.connect(analyser).connect(ctx.destination);
    this.analyser = analyser;
    const meterSplit = ctx.createChannelSplitter(2);
    master.connect(meterSplit);
    this.meters = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.meters.forEach((m, i) => {
      m.fftSize = 1024;
      meterSplit.connect(m, i);
    });
    const tracks = new Map<string, GainNode>();
    const nodes: AudioNode[] = [master, analyser, meterSplit, ...this.meters];
    this.dispose = () =>
      nodes.forEach((n) => {
        try {
          n.disconnect();
        } catch {}
      });
    const solo = a.lanes.some((l) => l.solo);
    for (const lane of a.lanes) {
      const gain = ctx.createGain(),
        split = ctx.createChannelSplitter(2),
        merge = ctx.createChannelMerger(2);
      gain.gain.value =
        lane.mute || (solo && !lane.solo) ? 0 : 10 ** (lane.gain_db / 20);
      const pan = panGains(lane.pan, a.pan_law),
        left = ctx.createGain(),
        right = ctx.createGain();
      left.gain.value = pan[0];
      right.gain.value = pan[1];
      gain.connect(split);
      split.connect(left, 0);
      split.connect(right, 1);
      left.connect(merge, 0, 0);
      right.connect(merge, 0, 1);
      merge.connect(master);
      tracks.set(lane.id, gain);
      nodes.push(gain, split, merge, left, right);
    }
    const scheduled = new Set<string>(),
      loading = new Set<string>();
    let origin = 0;
    const schedule = async (now: number, preload = false) => {
      const tasks: Promise<void>[] = [];
      for (const r of a.regions) {
        if (r.mute || end(r) <= now || r.start > now + 8) continue;
        const length = r.src_end - r.src_start;
        for (
          let chunk = Math.max(0, Math.floor((now - r.start) / 5));
          chunk <=
          Math.min(
            Math.ceil(length / 5) - 1,
            Math.floor((now + 8 - r.start) / 5),
          );
          chunk++
        ) {
          const key = `${r.id}/${chunk}`;
          if (scheduled.has(key) || loading.has(key)) continue;
          loading.add(key);
          tasks.push(
            (async () => {
              try {
                if (
                  !urls[r.clip] &&
                  !a.derived_clips.some((c) => c.id === r.clip)
                )
                  throw Error("Preview source is unavailable");
                const offset = chunk * 5,
                  span = Math.min(5, length - offset),
                  buffer = await this.window(
                    urls[r.clip] ?? r.clip,
                    r.src_start + offset,
                    span,
                  );
                if (epoch !== this.epoch) return;
                if (preload) return;
                const at = r.start + offset,
                  late = Math.max(0, ctx.currentTime - origin - at);
                scheduled.add(key);
                if (late >= buffer.duration) return;
                const source = ctx.createBufferSource(),
                  gain = ctx.createGain();
                source.buffer = buffer;
                source.connect(gain).connect(tracks.get(r.lane)!);
                const when = Math.max(ctx.currentTime, origin + at),
                  duration = buffer.duration - late,
                  from = offset + late;
                // Include exact fade breakpoints so a 5 ms fade is never stretched
                // over an entire five-second streaming window.
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
                  this.sources.delete(source);
                };
                source.start(when, late, duration);
                this.sources.add(source);
              } finally {
                loading.delete(key);
              }
            })(),
          );
        }
      }
      await Promise.all(tasks);
    };
    try {
      await schedule(position, true);
      if (epoch !== this.epoch) return;
      origin = ctx.currentTime + 0.06 - position;
      this.origin = origin;
      this.running = true;
      await schedule(position);
      let pending = false;
      const draw = () => {
        if (epoch !== this.epoch) {
          nodes.forEach((n) => n.disconnect());
          return;
        }
        const t = Math.max(position, ctx.currentTime - origin);
        if (a.loop.enabled && t >= a.loop.end) {
          this.stop();
          nodes.forEach((n) => n.disconnect());
          void this.play(a, a.loop.start, urls, tick, finish).catch(finish);
          return;
        }
        if (t >= a.duration) {
          this.stop();
          nodes.forEach((n) => n.disconnect());
          tick(a.duration);
          finish();
          return;
        }
        tick(t);
        if (!pending) {
          pending = true;
          void schedule(t)
            .catch(() => {
              this.stop();
              finish();
            })
            .finally(() => {
              pending = false;
            });
        }
        this.frame = requestAnimationFrame(draw);
      };
      this.frame = requestAnimationFrame(draw);
    } catch (e) {
      nodes.forEach((n) => n.disconnect());
      this.stop();
      throw e;
    }
  }
}
