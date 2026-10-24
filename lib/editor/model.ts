import { arrangementSchema, type Arrangement } from "../arrangement.ts";
import { duration, crossfadeRegions, snapTime, uid, type SnapMode } from "../daw/commands.ts";
export const AUDIO_EXTENSIONS = [
  "wav",
  "mp3",
  "flac",
  "m4a",
  "aac",
  "aiff",
  "aif",
  "ogg",
];
export const COLORS = [
  "#818CF8",
  "#A78BFA",
  "#34D399",
  "#FBBF24",
  "#F472B6",
  "#38BDF8",
];
export type Placement = { time: number; lane?: string; bin?: boolean };
export function audioType(name: string) {
  return AUDIO_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() ?? "");
}
export function blankArrangement(id: string): Arrangement {
  return arrangementSchema.parse({
    version: 2,
    job_id: id,
    editor_project: true,
    sample_rate: 48000,
    duration: 60,
    snap: true,
    pan_law: "equal_power",
    legacy_mastering: false,
    tempo: 120,
    time_signature: [4, 4],
    markers: [],
    loop: { enabled: false, start: 0, end: 60 },
    master: { gain_db: 0, inserts: [] },
    lanes: [],
    clips: [],
    regions: [],
    missing: [],
    unplaced: [],
    lines: [],
  });
}
export function importPlacement(
  a: Arrangement,
  clip: Arrangement["clips"][number],
  point: Placement,
  mode: SnapMode = "seconds",
  zoom = 50,
): Arrangement {
  const start = snapTime(a, point.time, mode, zoom),
    lanes = [...a.lanes];
  let lane = point.lane;
  if (!point.bin && !lanes.some((l) => l.id === lane)) {
    lane = uid();
    lanes.push({
      id: lane,
      name: clip.name.replace(/\.[^.]+$/, "").slice(0, 60),
      color: COLORS[lanes.length % COLORS.length],
      pan: 0,
      height: 120,
      inserts: [],
      gain_db: 0,
      mute: false,
      solo: false,
    });
  }
  const base = {
    ...a,
    lanes,
    clips: a.clips.some((c) => c.id === clip.id) ? a.clips : [...a.clips, clip],
  };
  return crossfadeRegions(
    duration(
      point.bin
        ? {
            ...base,
            unplaced: [
              ...a.unplaced,
              {
                clip: clip.id,
                src_start: 0,
                src_end: clip.duration,
                transcript: clip.name,
              },
            ],
          }
        : {
            ...base,
            regions: [
              ...a.regions,
              {
                id: uid(),
                lane: lane!,
                kind: "clip",
                clip: clip.id,
                src_start: 0,
                src_end: clip.duration,
                start,
                gain_db: 0,
                line: 0,
                confidence: 1,
                name: clip.name,
                mute: false,
                fade_in: 0,
                fade_out: 0,
                fade_curve: "linear",
                lines: [],
              },
            ],
          },
    ),
  );
}
export function exportSpan(
  a: Arrangement,
  range: "whole" | "loop" | "selection",
  selection?: [number, number],
): [number, number] {
  if (!a.regions.length) throw Error("Import or place audio before exporting.");
  if (range === "loop") return [a.loop.start, a.loop.end];
  if (range === "selection") {
    if (!selection || selection[1] <= selection[0])
      throw Error("Select a range on the timeline first.");
    return selection;
  }
  return [
    0,
    Math.max(...a.regions.map((r) => r.start + r.src_end - r.src_start)),
  ];
}
