import { z } from "zod";
const time = z.number().finite().min(0).max(14400);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const gain = z.number().finite().min(-60).max(24);
export const arrangementSchema = z
  .object({
    version: z.literal(1),
    job_id: z.uuid(),
    sample_rate: z.literal(48000),
    duration: time.positive(),
    snap: z.boolean(),
    line_gap_ms: z.number().int().min(0).max(5000).optional(),
    match_strictness: z.enum(["strict", "normal", "loose"]).optional(),
    lanes: z
      .array(
        z.object({
          id,
          name: z.string().max(60),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          gain_db: gain,
          mute: z.boolean(),
          solo: z.boolean(),
        }),
      )
      .min(1)
      .max(300),
    clips: z
      .array(
        z.object({ id, name: z.string().max(255), duration: time.positive() }),
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
      clips = new Map(a.clips.map((c) => [c.id, c.duration]));
    const ids = a.regions.map((r) => r.id);
    if (a.regions.reduce((n, r) => n + r.src_end - r.src_start, 0) > 14400)
      ctx.addIssue({
        code: "custom",
        message: "Arrangement render budget exceeded",
      });
    if (
      new Set(ids).size !== ids.length ||
      lanes.size !== a.lanes.length ||
      clips.size !== a.clips.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate IDs" });
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
export type Arrangement = z.infer<typeof arrangementSchema>;
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
