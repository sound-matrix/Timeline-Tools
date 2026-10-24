import {
  cutRanges,
  remapTime,
  outputToSource,
  type PodcastEdits,
} from "../podcast.ts";
import { pcmWindow } from "../studio-preview.ts";
import { arrangementSchema, type Arrangement } from "../arrangement.ts";
export function podcastPlan(seconds: number, edits: PodcastEdits) {
  const cuts = cutRanges(edits),
    inserts = edits.operations
      .filter(
        (
          o,
        ): o is Extract<PodcastEdits["operations"][number], { op: "insert" }> =>
          o.op === "insert",
      )
      .filter((o) => !cuts.some(([a, b]) => o.at > a && o.at < b));
  const points = [
    ...new Set([0, seconds, ...cuts.flat(), ...inserts.map((o) => o.at)]),
  ].sort((a, b) => a - b);
  const plan: {
    source: number;
    start: number;
    length: number;
    gap: boolean;
  }[] = [];
  let cursor = 0;
  for (let i = 0; i < points.length; i++) {
    const source = points[i],
      gap = inserts
        .filter((o) => o.at === source)
        .reduce((n, o) => n + o.duration, 0);
    if (gap) {
      plan.push({ source, start: cursor, length: gap, gap: true });
      cursor += gap;
    }
    const next = points[i + 1];
    if (next === undefined || cuts.some(([a, b]) => source >= a && next <= b))
      continue;
    plan.push({ source, start: cursor, length: next - source, gap: false });
    cursor += next - source;
  }
  return plan;
}
export function localPodcastEdits(
  edits: PodcastEdits,
  offset: number,
  seconds: number,
): PodcastEdits {
  return {
    operations: edits.operations.flatMap<PodcastEdits["operations"][number]>(
      (o) => {
        if (o.op === "insert")
          return o.at >= offset && o.at <= offset + seconds
            ? [{ ...o, at: o.at - offset }]
            : [];
        const start = Math.max(0, o.start - offset),
          end = Math.min(seconds, o.end - offset);
        return end > start ? [{ ...o, start, end }] : [];
      },
    ),
    corrections: {},
    speaker_names: {},
  };
}
export function podcastRenderArrangement(a: Arrangement, edits: PodcastEdits, sourceIds?:Set<string>) {
  const local = new Map(
    a.clips.map((c) => [
      c.id,
      sourceIds && !sourceIds.has(c.id) ? {operations:[],corrections:{},speaker_names:{}} : c.id === "source"
        ? edits
        : localPodcastEdits(edits, c.offset ?? 0, c.duration),
    ]),
  );
  const regions = a.regions.flatMap((r) => {
    const source =
        a.derived_clips.find((c) => c.id === r.clip)?.source ?? r.clip,
      e = local.get(source) ?? edits;
    const left = remapTime(r.src_start, e),
      right = remapTime(r.src_end, e, false);
    return right > left
      ? [
          {
            ...r,
            src_start: left,
            src_end: right,
            start: remapTime(r.start, edits),
          },
        ]
      : [];
  });
  const length = remapTime(a.duration, edits);
  return arrangementSchema.parse({
    ...a,
    duration: length,
    clips: a.clips.map((c) => ({
      ...c,
      duration: Math.max(0.001, remapTime(c.duration, local.get(c.id)!)),
    })),
    regions,
    loop: {
      ...a.loop,
      start: Math.min(length - 0.001, remapTime(a.loop.start, edits)),
      end: Math.max(0.001, remapTime(a.loop.end, edits)),
    },
    markers: a.markers.map((m) => ({ ...m, time: remapTime(m.time, edits) })),
  });
}
export async function podcastWindow(
  ctx: AudioContext,
  url: string,
  start: number,
  length: number,
  seconds: number,
  edits: PodcastEdits,
) {
  const buffer = ctx.createBuffer(2, Math.round(length * 48000), 48000),
    plan = podcastPlan(seconds, edits);
  for (const span of plan) {
    const left = Math.max(start, span.start),
      right = Math.min(start + length, span.start + span.length);
    if (right <= left || span.gap) continue;
    const original = span.source + left - span.start,
      read = await pcmWindow(ctx, url, original, right - left),
      at = Math.round((left - start) * 48000);
    for (let ch = 0; ch < 2; ch++) {
      const data = read.getChannelData(Math.min(ch, read.numberOfChannels - 1)),
        out = buffer.getChannelData(ch);
      for (
        let i = 0;
        i < Math.min(Math.round((right - left) * 48000), out.length - at);
        i++
      ) {
        const time = original + i / 48000;
        let v =
          data[
            Math.min(data.length - 1, Math.round((i * read.sampleRate) / 48000))
          ] ?? 0;
        for (const o of edits.operations) {
          if (
            (o.op === "mute" || o.op === "bleep") &&
            time >= o.start &&
            time < o.end
          )
            v =
              o.op === "mute"
                ? 0
                : Math.sin(2 * Math.PI * 1000 * time) * 10 ** (o.db / 20);
        }
        out[at + i] = v;
      }
    }
  }
  return buffer;
}
/** Keep the edit ruler, output audio clock and original video clock distinct. */
export function podcastViewTime(
  a: Arrangement,
  edits: PodcastEdits,
  view: number,
) {
  const r = a.regions.find(
    (r) => view >= r.start && view < r.start + r.src_end - r.src_start,
  );
  if (!r) return { source: view, output: remapTime(view, edits) };
  const c = a.clips.find((c) => c.id === r.clip),
    e =
      c && c.id !== "source"
        ? localPodcastEdits(edits, c.offset ?? 0, c.duration)
        : edits;
  const local = r.src_start + view - r.start;
  return {
    source: (c?.offset ?? 0) + local,
    output:
      remapTime(r.start, edits) +
      remapTime(local, e) -
      remapTime(r.src_start, e),
  };
}
export function podcastOutputTime(
  a: Arrangement,
  rendered: Arrangement,
  edits: PodcastEdits,
  output: number,
) {
  const r = rendered.regions.find(
      (r) => output >= r.start && output < r.start + r.src_end - r.src_start,
    ),
    original = a.regions.find((o) => o.id === r?.id),
    c = a.clips.find((c) => c.id === r?.clip);
  if (!r || !original || !c) {
    const mapped = outputToSource(
      output,
      a.clips[0].id === "source" ? a.clips[0].duration : a.duration,
      edits,
    );
    return { view: mapped.time, source: mapped.time, gap: mapped.gap };
  }
  const e =
      c.id === "source"
        ? edits
        : localPodcastEdits(edits, c.offset ?? 0, c.duration),
    mapped = outputToSource(r.src_start + output - r.start, c.duration, e);
  return {
    view: original.start + mapped.time - original.src_start,
    source: (c.offset ?? 0) + mapped.time,
    gap: mapped.gap,
  };
}
