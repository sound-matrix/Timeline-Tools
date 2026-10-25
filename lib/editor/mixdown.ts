import { createEffectChain, prepareEffectContext } from "../daw/effects.ts";
import type { Arrangement } from "../arrangement.ts";
import { fadeValue, panGains, end } from "../daw/commands.ts";
import { DawPlayback } from "../daw/playback.ts";
export type MixOptions = {
  format: "wav" | "mp3";
  rate: 44100 | 48000 | 96000;
  depth: 16 | 24;
  bitrate: 128 | 192 | 256 | 320;
  normalize: boolean;
};
export async function offlineBlock(
  a: Arrangement,
  from: number,
  length: number,
  rate: number,
  reader: (url: string, start: number, length: number) => Promise<AudioBuffer>,
  urls: Record<string, string>,
  scale = 1,
) {
  const ctx = new OfflineAudioContext(2, Math.round(length * rate), rate),
    master = ctx.createGain(),
    analyser = ctx.createAnalyser();
  await prepareEffectContext(ctx);
  master.gain.value =
    10 ** ((a.master.gain_db + (a.master.reference_gain_db ?? 0)) / 20) * scale;
  const masterFx = createEffectChain(ctx, a.master.inserts, a.tempo);
  master.connect(masterFx.input);
  masterFx.output.connect(analyser).connect(ctx.destination);
  const solo = a.lanes.some((l) => l.solo),
    tracks = new Map<string, GainNode>();
  for (const l of a.lanes) {
    const gain = ctx.createGain(),
      split = ctx.createChannelSplitter(2),
      merge = ctx.createChannelMerger(2),
      left = ctx.createGain(),
      right = ctx.createGain(),
      insertChain = ctx.createGain();
    gain.channelCount = 2;
    gain.channelCountMode = "explicit";
    gain.gain.value = l.mute || (solo && !l.solo) ? 0 : 10 ** (l.gain_db / 20);
    const pan = panGains(l.pan, a.pan_law);
    left.gain.value = pan[0];
    right.gain.value = pan[1];
    gain.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);
    left.connect(merge, 0, 0);
    right.connect(merge, 0, 1);
    const fx = createEffectChain(ctx, l.inserts, a.tempo);
    insertChain.connect(fx.input);
    fx.output.connect(gain);
    merge.connect(master);
    tracks.set(l.id, insertChain);
  }
  for (const r of a.regions) {
    if (r.mute || end(r) <= from || r.start >= from + length) continue;
    const start = Math.max(from, r.start),
      finish = Math.min(from + length, end(r)),
      offset = start - r.start;
    const buffer = await reader(
        urls[r.clip] ?? r.clip,
        r.reverse
          ? r.src_end - offset - (finish - start)
          : r.src_start + offset,
        finish - start,
      ),
      source = ctx.createBufferSource(),
      gain = ctx.createGain();
    if (r.reverse)
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        // Do not mutate cached source buffers.
        const copy = ctx.createBuffer(
          buffer.numberOfChannels,
          buffer.length,
          buffer.sampleRate,
        );
        for (let c = 0; c < buffer.numberOfChannels; c++)
          copy
            .getChannelData(c)
            .set(buffer.getChannelData(c).slice().reverse());
        source.buffer = copy;
        break;
      }
    else source.buffer = buffer;
    const points = [
      ...new Set(
        [
          offset,
          finish - r.start,
          r.fade_in,
          r.src_end - r.src_start - r.fade_out,
        ].filter((v) => v >= offset && v <= finish - r.start),
      ),
    ].sort((a, b) => a - b);
    for (let j = 0; j < points.length - 1; j++) {
      const begin = points[j],
        duration = points[j + 1] - begin;
      if (duration <= 0) continue;
      const values = new Float32Array(
        Math.max(2, Math.min(8192, Math.ceil(duration * rate))),
      );
      for (let i = 0; i < values.length; i++)
        values[i] =
          10 ** (r.gain_db / 20) *
          fadeValue(r, begin + (duration * i) / (values.length - 1));
      gain.gain.setValueCurveAtTime(
        values,
        start - from + begin - offset,
        duration,
      );
    }
    const fx = createEffectChain(ctx, r.inserts ?? [], a.tempo);
    source.connect(gain).connect(fx.input);
    fx.output.connect(tracks.get(r.lane)!);
    source.start(start - from, 0, finish - start);
  }
  return ctx.startRendering();
}
export async function clientMixdown(
  a: Arrangement,
  span: [number, number],
  urls: Record<string, string>,
  readWindow: DawPlayback["reader"],
  options: MixOptions,
  onProgress: (p: number) => void,
) {
  if (span[1] <= span[0]) throw Error("Choose a non-empty export range.");
  if (options.format === "mp3" && options.rate === 96000)
    throw Error("MP3 supports 44.1 or 48 kHz.");

  const hasFx =
    a.lanes.some((l) => l.inserts.some((s) => s.enabled)) ||
    a.master.inserts.some((s) => s.enabled) ||
    a.regions.some((r) => r.inserts?.some((s) => s.enabled));
  const player = new DawPlayback();
  player.tempo = a.tempo;
  player.derived = a.derived_clips;
  player.sourceUrls = urls;
  player.reader = readWindow;
  const worker = new Worker("/daw/export-worker.js");
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p?.reject(Error(data.error));
    else p?.resolve(data);
  };
  worker.onerror = () => {
    for (const p of pending.values()) p.reject(Error("Export encoder failed"));
    pending.clear();
  };
  const request = (
    data: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...data, id }, transfer);
    });
  try {
    let scale = 1;
    if (options.normalize) {
      let peak = 0;
      for (let at = span[0]; at < span[1]; at += 5) {
        const b = await offlineBlock(
          a,
          hasFx ? Math.max(0, at - 60) : at,
          Math.min(5, span[1] - at) + (hasFx ? Math.min(at, 60) : 0),
          options.rate,
          (...args) => player.window(...args),
          urls,
        );
        for (let ch = 0; ch < 2; ch++) {
          const data = b
            .getChannelData(ch)
            .subarray(
              Math.round((hasFx ? Math.min(at, 60) : 0) * options.rate),
            );
          for (let i = 0; i < data.length; i += 65536) {
            const block = data.subarray(i, i + 65536);
            for (const v of block) peak = Math.max(peak, Math.abs(v));
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }
      if (peak > 0) scale = 1 / peak;
    }
    await request({ op: "begin", ...options });
    for (let at = span[0]; at < span[1]; at += 5) {
      const b = await offlineBlock(
        a,
        hasFx ? Math.max(0, at - 60) : at,
        Math.min(5, span[1] - at) + (hasFx ? Math.min(at, 60) : 0),
        options.rate,
        (...args) => player.window(...args),
        urls,
        scale,
      );
      const skip = Math.round((hasFx ? Math.min(at, 60) : 0) * options.rate);
      const channels = [
        b.getChannelData(0).slice(skip),
        b.getChannelData(1).slice(skip),
      ];
      await request(
        { op: "chunk", channels },
        channels.map((c) => c.buffer),
      );
      onProgress(
        Math.min(
          100,
          Math.round(((at + 5 - span[0]) / (span[1] - span[0])) * 100),
        ),
      );
    }
    return (await request({ op: "finish" })).blob as Blob;
  } finally {
    worker.terminate();
    await player.close();
  }
}
