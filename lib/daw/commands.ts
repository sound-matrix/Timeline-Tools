import { arrangementDuration, type Arrangement } from "../arrangement.ts";
export type Region = Arrangement["regions"][number];
export type Track = Arrangement["lanes"][number];
export type Tool =
  "pointer" | "razor" | "trim" | "fade" | "range" | "zoom" | "hand";
export type SnapMode =
  | "off"
  | "frames24"
  | "frames25"
  | "frames30"
  | "seconds"
  | "milliseconds"
  | "beats"
  | "edges"
  | "markers"
  | "bars";
export const uid = () => crypto.randomUUID();
export const end = (r: Region) => r.start + r.src_end - r.src_start;
export function fadeValue(
  r: Pick<
    Region,
    "src_start" | "src_end" | "fade_in" | "fade_out" | "fade_curve"
  >,
  position: number,
) {
  const ramp = (x: number, n: number) =>
    n > 0 ? Math.min(1, Math.max(0, x / n)) : 1;
  const curve = (x: number) =>
    r.fade_curve === "equal_power" ? Math.sin((x * Math.PI) / 2) : x;
  return (
    curve(ramp(position, r.fade_in)) *
    curve(ramp(r.src_end - r.src_start - position, r.fade_out))
  );
}
export function panGains(
  pan: number,
  law: Arrangement["pan_law"] = "equal_power",
) {
  if (law === "legacy")
    return pan === 0
      ? [1, 1]
      : [
          Math.min(1, Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2),
          Math.min(1, Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2),
        ];
  return [
    Math.cos(((pan + 1) * Math.PI) / 4),
    Math.sin(((pan + 1) * Math.PI) / 4),
  ];
}
export function splitRegions(
  a: Arrangement,
  ids: string[],
  time: number,
): Arrangement {
  return {
    ...a,
    regions: a.regions.flatMap((r) => {
      if (
        !ids.includes(r.id) ||
        time <= r.start + 0.001 ||
        time >= end(r) - 0.001
      )
        return [r];
      const at = r.src_start + time - r.start;
      return [
        {
          ...r,
          src_end: at,
          fade_out: 0,
          fade_in: Math.min(r.fade_in, time - r.start),
        },
        {
          ...r,
          id: uid(),
          src_start: at,
          start: time,
          fade_in: 0,
          fade_out: Math.min(r.fade_out, end(r) - time),
        },
      ];
    }),
  };
}
export function deleteRegions(
  a: Arrangement,
  ids: string[],
  ripple = false,
): Arrangement {
  const removed = a.regions.filter((r) => ids.includes(r.id));
  // Ripple by the union of selected spans on each lane, never double-count overlap.
  return {
    ...a,
    regions: a.regions
      .filter((r) => !ids.includes(r.id))
      .map((r) => {
        if (!ripple) return r;
        let last = 0,
          shift = 0;
        for (const q of removed
          .filter((q) => q.lane === r.lane && q.start < r.start)
          .sort((x, y) => x.start - y.start)) {
          shift += Math.max(
            0,
            Math.min(r.start, end(q)) - Math.max(last, q.start),
          );
          last = Math.max(last, end(q));
        }
        return { ...r, start: Math.max(0, r.start - shift) };
      }),
  };
}
export function snapTime(
  a: Arrangement,
  t: number,
  mode: SnapMode,
  zoom: number,
  exclude: string[] = [],
) {
  if (mode === "off" || !a.snap) return Math.max(0, t);
  if (mode === "edges" || mode === "markers") {
    const edges = [
      0,
      ...a.markers.map((m) => m.time),
      ...(mode === "markers" ? [] : a.regions)
        .filter((r) => !exclude.includes(r.id))
        .flatMap((r) => [r.start, end(r)]),
    ];
    const closest = edges.reduce(
      (v, e) => (Math.abs(e - t) < Math.abs(v - t) ? e : v),
      Infinity,
    );
    return Math.max(0, Math.abs(closest - t) <= 8 / zoom ? closest : t);
  }
  const step = mode.startsWith("frames")
    ? 1 / Number(mode.slice(6))
    : mode === "bars"
      ? (((60 / a.tempo) * 4) / a.time_signature[1]) * a.time_signature[0]
      : mode === "beats"
        ? ((60 / a.tempo) * 4) / a.time_signature[1]
        : mode === "milliseconds"
          ? 0.001
          : 1;
  return Math.max(0, Math.round(t / step) * step);
}
export function duration(a: Arrangement): Arrangement {
  return {
    ...a,
    duration: Math.min(14400, Math.max(a.duration, arrangementDuration(a))),
  };
}
export type Command = {
  label: string;
  before: Arrangement;
  after: Arrangement;
};
/** Commands retain immutable before/after snapshots; one gesture is one command. */
export class CommandHistory {
  past: Command[] = [];
  future: Command[] = [];
  execute(label: string, before: Arrangement, after: Arrangement) {
    if (JSON.stringify(before) === JSON.stringify(after)) return before;
    this.past.push({ label, before, after });
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    return after;
  }
  undo(current: Arrangement) {
    const c = this.past.pop();
    if (!c) return current;
    this.future.push(c);
    return c.before;
  }
  redo(current: Arrangement) {
    const c = this.future.pop();
    if (!c) return current;
    this.past.push(c);
    return c.after;
  }
}
export function rulerStamp(
  t: number,
  mode: string,
  a: Pick<Arrangement, "tempo" | "time_signature">,
) {
  if (mode === "bars") {
    const beats = (((t * a.tempo) / 60) * a.time_signature[1]) / 4;
    return `${Math.floor(beats / a.time_signature[0]) + 1}|${Math.floor(beats % a.time_signature[0]) + 1}|${String(Math.round((beats % 1) * 960)).padStart(3, "0")}`;
  }
  if (mode.startsWith("timecode")) {
    const fps = Number(mode.slice(8)) || 25;
    return `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(Math.floor(t) % 60).padStart(2, "0")}:${String(Math.floor((t % 1) * fps)).padStart(2, "0")}`;
  }
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, "0")}`;
}
/** Adjacent partial overlaps use matching equal-power envelopes. */
export function crossfadeRegions(a: Arrangement): Arrangement {
  const regions = a.regions.map((r) => ({ ...r }));
  for (const lane of a.lanes) {
    const ordered = regions
      .filter((r) => r.lane === lane.id)
      .sort((x, y) => x.start - y.start);
    for (let i = 0; i < ordered.length - 1; i++) {
      const first = ordered[i],
        second = ordered[i + 1];
      if (
        first.start < second.start &&
        end(first) > second.start &&
        end(first) <= end(second)
      ) {
        const overlap = end(first) - second.start;
        first.fade_out = overlap;
        second.fade_in = overlap;
        first.fade_curve = second.fade_curve = "equal_power";
      }
    }
  }
  return { ...a, regions };
}
