import { z } from "zod";
export const extensions = [
  "wav",
  "mp3",
  "m4a",
  "flac",
  "aac",
  "ogg",
  "mp4",
  "mov",
  "mkv",
  "webm",
];
const legacyCleanSchema = z
  .object({
    noise: z.boolean(),
    hum: z.boolean(),
    reverb: z.boolean(),
    voice: z.boolean(),
    strength: z.number().int().min(0).max(100),
  })
  .strict()
  .refine(
    (s) => s.noise || s.hum || s.reverb || s.voice,
    "Select at least one processing option.",
  );
const disabled = z.object({ enabled: z.literal(false) }).strict();
const cleanAmount = z.literal([30, 60, 100]);
const amountStage = z.discriminatedUnion("enabled", [
  disabled,
  z.object({ enabled: z.literal(true), amount: cleanAmount }).strict(),
]);
export const cleanDeskSchema = z
  .object({
    noise: z.discriminatedUnion("enabled", [
      disabled,
      z
        .object({
          enabled: z.literal(true),
          method: z.enum(["speech_music", "speech", "aggressive"]),
          amount: cleanAmount,
        })
        .strict(),
    ]),
    hum: amountStage,
    reverb: amountStage,
    voice: z.boolean(),
  })
  .strict()
  .refine(
    (s) => s.noise.enabled || s.hum.enabled || s.reverb.enabled || s.voice,
    "Select at least one processing option.",
  );
// Preserve queued Phase 1C jobs while new forms send independent stage settings.
export const cleanSchema = z.union([cleanDeskSchema, legacyCleanSchema]);
const knee = z.enum(["soft", "hard"]);
const band = z.discriminatedUnion("enabled", [
  disabled,
  z
    .object({ enabled: z.literal(true), gain: z.number().min(-12).max(12) })
    .strict(),
]);
export const masterSchema = z
  .object({
    loudness: z.discriminatedUnion("enabled", [
      disabled,
      z
        .object({ enabled: z.literal(true), lufs: z.number().min(-70).max(-5) })
        .strict(),
    ]),
    limiter: z.discriminatedUnion("enabled", [
      disabled,
      z
        .object({
          enabled: z.literal(true),
          ceiling: z.number().min(-6).max(0),
          knee,
          release: z.number().min(50).max(1000),
        })
        .strict(),
    ]),
    compressor: z.discriminatedUnion("enabled", [
      disabled,
      z
        .object({
          enabled: z.literal(true),
          threshold: z.number().min(-60).max(0),
          ratio: z.number().min(1).max(20),
          attack: z.number().min(0.01).max(2000),
          release: z.number().min(0.01).max(9000),
          knee,
          makeup: z.discriminatedUnion("mode", [
            z.object({ mode: z.literal("auto") }).strict(),
            z
              .object({
                mode: z.literal("manual"),
                gain: z.number().min(-24).max(24),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
    eq: z.discriminatedUnion("enabled", [
      disabled,
      z
        .object({
          enabled: z.literal(true),
          bands: z
            .array(band)
            .length(5)
            .refine(
              (bands) => bands.some((b) => b.enabled),
              "Enable at least one EQ band.",
            ),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    (s) =>
      s.loudness.enabled ||
      s.limiter.enabled ||
      s.compressor.enabled ||
      s.eq.enabled,
    "Enable at least one mastering stage.",
  );
export const subtitlesSchema = z
  .object({
    language: z.enum(["English", "Hindi", "Telugu", "Tamil"]),
    formats: z
      .array(z.enum(["srt", "vtt"]))
      .min(1)
      .max(2),
  })
  .strict();
// Studio choices never coerce blanks or infer an enabled stage.
export const studioSchema = z
  .object({
    dialogue_lufs: z.number().min(-70).max(-5),
    master_lufs: z.number().min(-70).max(-5),
    has_bed: z.boolean(),
    ducking_db: z.number().min(0).max(40).optional(),
    room_tone: z.discriminatedUnion("enabled", [
      disabled,
      z
        .object({
          enabled: z.literal(true),
          amount: z.number().min(0).max(100),
        })
        .strict(),
    ]),
    subtitles: z.discriminatedUnion("enabled", [
      disabled,
      z
        .object({
          enabled: z.literal(true),
          formats: z
            .array(z.enum(["srt", "vtt"]))
            .min(1)
            .max(2)
            .refine(
              (f) => new Set(f).size === f.length,
              "Choose each format once.",
            ),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    (s) =>
      s.has_bed ? s.ducking_db !== undefined : s.ducking_db === undefined,
    "Choose ducking when a music/SFX bed is present.",
  );
export const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clean"), settings: cleanSchema }),
  z.object({ type: z.literal("master"), settings: masterSchema }),
  z.object({ type: z.literal("subtitles"), settings: subtitlesSchema }),
  z.object({ type: z.literal("studio"), settings: studioSchema }),
]);
export type JobType = "clean" | "master" | "subtitles" | "studio";
