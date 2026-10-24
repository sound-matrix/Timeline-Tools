import { z } from "zod";
export const editorExportSchema = z
  .object({
    revision: z.number().int().positive(),
    expected_cost: z.number().int().nonnegative(),
    range: z
      .tuple([
        z.number().finite().min(0),
        z.number().finite().positive().max(14400),
      ])
      .refine(([a, b]) => b > a),
    options: z
      .object({
        format: z.enum(["wav", "mp3"]).default("wav"),
        rate: z
          .union([z.literal(44100), z.literal(48000), z.literal(96000)])
          .default(48000),
        depth: z.union([z.literal(16), z.literal(24)]).default(24),
        bitrate: z
          .union([
            z.literal(128),
            z.literal(192),
            z.literal(256),
            z.literal(320),
          ])
          .default(320),
        normalize: z.boolean().default(false),
      })
      .strict(),
    subtitles: z
      .array(z.enum(["srt", "vtt"]))
      .max(2)
      .default([]),
  })
  .strict()
  .refine(
    (s) => s.options.format !== "mp3" || s.options.rate !== 96000,
    "MP3 supports 44.1 or 48 kHz",
  );
