import { z } from "zod";
const time = z.number().finite().min(0).max(14400);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const gain = z.number().finite().min(-60).max(24);
const v2Schema = z
  .object({
    version: z.literal(2),
    job_id: z.uuid(),
    sample_rate: z.literal(48000),
    duration: time.positive(),
    snap: z.boolean(),
    legacy_mastering: z.boolean().default(false),
    pan_law: z.enum(["equal_power", "legacy"]).default("equal_power"),
    tempo: z.number().finite().min(20).max(300).default(120),
    time_signature: z
      .tuple([
        z.number().int().min(1).max(16),
        z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
      ])
      .default([4, 4]),
    markers: z
      .array(
        z.object({
          id,
          time,
          name: z.string().max(80),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        }),
      )
      .max(1000)
      .default([]),
    loop: z.object({ enabled: z.boolean(), start: time, end: time }),
    master: z.object({
      gain_db: gain,
      reference_gain_db: gain.default(0),
      inserts: z.array(z.never()).max(0),
    }),
    line_gap_ms: z.number().int().min(0).max(5000).optional(),
    match_strictness: z.enum(["strict", "normal", "loose"]).optional(),
    lanes: z
      .array(
        z.object({
          id,
          name: z.string().max(60),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          pan: z.number().finite().min(-1).max(1).default(0),
          height: z.number().int().min(60).max(400).default(120),
          inserts: z.array(z.never()).max(0).default([]),
          gain_db: gain,
          mute: z.boolean(),
          solo: z.boolean(),
        }),
      )
      .min(1)
      .max(300),
    derived_clips: z
      .array(
        z.object({
          id,
          name: z.string().max(255),
          duration: time.positive(),
          source: id,
          src_start: time,
          src_end: time,
          gain_db: gain,
          fade_in: time,
          fade_out: time,
          fade_curve: z.enum(["linear", "equal_power"]),
        }),
      )
      .max(200)
      .default([]),
    clips: z
      .array(
        z.object({
          id,
          name: z.string().max(255),
          duration: time.positive(),
          offset: time.optional(),
        }),
      )
      .min(1)
      .max(200),
    regions: z
      .array(
        z.object({
          id,
          lane: id,
          kind: z.literal("clip"),
          clip: id,
          src_start: time,
          src_end: time,
          start: time,
          gain_db: gain,
          line: z.number().int().min(0).max(1999),
          confidence: z.number().min(0).max(1),
          name: z.string().max(255).optional(),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
          mute: z.boolean().default(false),
          fade_in: time.default(0),
          fade_out: time.default(0),
          fade_curve: z.enum(["linear", "equal_power"]).default("linear"),
          lines: z
            .array(
              z.object({
                line: z.number().int().min(0).max(1999),
                src_start: time,
                src_end: time,
                confidence: z.number().finite().min(0).max(1),
              }),
            )
            .max(2000)
            .default([]),
        }),
      )
      .max(2000),
    missing: z
      .array(
        z.object({
          line: z.number().int().min(0).max(1999),
          lane: id,
          start: time,
          length: time.positive(),
          text: z.string().max(1000),
        }),
      )
      .max(300),
    unplaced: z
      .array(
        z.object({
          clip: id,
          src_start: time,
          src_end: time,
          transcript: z.string().max(5000),
        }),
      )
      .max(2000),
    lines: z
      .array(
        z.object({
          index: z.number().int().min(0).max(1999),
          speaker: z.string().max(60),
          text: z.string().max(1000),
        }),
      )
      .min(1)
      .max(2000),
  })
  .strict()
  .superRefine((a, ctx) => {
    const lanes = new Set(a.lanes.map((l) => l.id)),
      clips = new Map(
        [...a.clips, ...a.derived_clips].map((c) => [c.id, c.duration]),
      );
    const ids = a.regions.map((r) => r.id);
    if (
      uniqueSourceSeconds(
        a.regions.map((r) => {
          const c = a.derived_clips.find((c) => c.id === r.clip);
          return c
            ? {
                ...r,
                clip: c.source,
                src_start: c.src_start + r.src_start,
                src_end: c.src_start + r.src_end,
              }
            : r;
        }),
      ) > 14400
    )
      ctx.addIssue({
        code: "custom",
        message: "Arrangement render budget exceeded",
      });
    if (
      new Set(ids).size !== ids.length ||
      lanes.size !== a.lanes.length ||
      clips.size !== a.clips.length + a.derived_clips.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate IDs" });
    const base = new Map(a.clips.map((c) => [c.id, c.duration]));
    for (const c of a.derived_clips)
      if (
        !base.has(c.source) ||
        c.src_start >= c.src_end ||
        c.src_end > (base.get(c.source) ?? 0) + 0.001 ||
        Math.abs(c.duration - c.src_end + c.src_start) > 0.001
      )
        ctx.addIssue({ code: "custom", message: "Invalid bounced source" });
    for (const r of [...a.regions, ...a.unplaced])
      if (
        !clips.has(r.clip) ||
        r.src_end <= r.src_start ||
        r.src_end > (clips.get(r.clip) ?? 0) + 0.001
      )
        ctx.addIssue({ code: "custom", message: "Invalid source range" });
    for (const r of a.regions)
      if (
        !lanes.has(r.lane) ||
        r.line >= a.lines.length ||
        r.start + r.src_end - r.src_start > a.duration + 0.001
      )
        ctx.addIssue({ code: "custom", message: "Invalid region" });
    if (
      a.loop.end <= a.loop.start ||
      a.loop.end > a.duration ||
      a.markers.some((m) => m.time > a.duration)
    )
      ctx.addIssue({ code: "custom", message: "Invalid loop or marker" });
    for (const r of a.regions)
      for (const l of r.lines)
        if (
          l.line >= a.lines.length ||
          l.src_end <= l.src_start ||
          l.src_end > (clips.get(r.clip) ?? 0) + 0.001
        )
          ctx.addIssue({ code: "custom", message: "Invalid caption" });
    for (const r of a.missing)
      if (
        !lanes.has(r.lane) ||
        r.line >= a.lines.length ||
        r.start + r.length > a.duration + 0.001
      )
        ctx.addIssue({ code: "custom", message: "Invalid missing line" });
    if (new TextEncoder().encode(JSON.stringify(a)).length > 524288)
      ctx.addIssue({ code: "custom", message: "Arrangement exceeds 512 KB" });
  });
export type Arrangement = z.infer<typeof v2Schema>;
/** Structural, non-destructive migration: legacy edits retain their source ranges. */
export function migrateArrangement(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const a = value as Record<string, unknown>;
  if (a.version !== 1 && a.version !== 2) return value;
  return {
    ...a,
    version: 2,
    legacy_mastering: a.legacy_mastering ?? a.version === 1,
    pan_law: a.pan_law ?? (a.version === 1 ? "legacy" : "equal_power"),
    markers: a.markers ?? [],
    loop: a.loop ?? { enabled: false, start: 0, end: a.duration },
    tempo: a.tempo ?? 120,
    time_signature: a.time_signature ?? [4, 4],
    master: a.master ?? { gain_db: 0, inserts: [] },
    regions: Array.isArray(a.regions)
      ? a.regions.map((r) => ({
          ...r,
          lines: r.lines ?? [
            {
              line: r.line,
              src_start: r.src_start,
              src_end: r.src_end,
              confidence: r.confidence,
            },
          ],
        }))
      : a.regions,
  };
}
export const arrangementSchema = z.preprocess(migrateArrangement, v2Schema);
export function uniqueSourceSeconds(
  regions: Pick<
    Arrangement["regions"][number],
    "clip" | "src_start" | "src_end"
  >[],
) {
  const clips = new Map<string, [number, number][]>();
  for (const r of regions)
    clips.set(r.clip, [...(clips.get(r.clip) ?? []), [r.src_start, r.src_end]]);
  let total = 0;
  for (const ranges of clips.values()) {
    let end = -1;
    for (const [a, b] of ranges.sort((a, b) => a[0] - b[0])) {
      total += Math.max(0, b - Math.max(a, end));
      end = Math.max(end, b);
    }
  }
  return total;
}
export const exportSettingsSchema = z
  .object({
    revision: z.number().int().positive(),
    formats: z
      .array(z.enum(["mp3", "wav"]))
      .min(1)
      .max(2),
    mp3: z
      .object({
        bitrate_kbps: z.literal([128, 192, 256, 320]),
        sample_rate: z.literal([44100, 48000]),
      })
      .strict()
      .optional(),
    wav: z
      .object({
        bit_depth: z.union([z.literal(16), z.literal(24), z.literal("32f")]),
        sample_rate: z.literal([44100, 48000, 96000]),
      })
      .strict()
      .optional(),
    subtitles: z.array(z.enum(["srt", "vtt"])).max(2),
    missing_lines: z.enum(["exclude", "mark"]),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.formats).size === s.formats.length &&
      new Set(s.subtitles).size === s.subtitles.length &&
      s.formats.includes("mp3") === !!s.mp3 &&
      s.formats.includes("wav") === !!s.wav,
    "Choose settings for each format",
  );
export type ExportSettings = z.infer<typeof exportSettingsSchema>;
export function arrangementDuration(a: Arrangement) {
  return Math.max(
    0.001,
    ...a.regions.map((r) => r.start + r.src_end - r.src_start),
    ...a.missing.map((r) => r.start + r.length),
  );
}
