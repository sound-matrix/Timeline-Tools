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
export const cleanSchema = z
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
export const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("clean"), settings: cleanSchema }),
  z.object({ type: z.literal("master"), settings: masterSchema }),
  z.object({ type: z.literal("subtitles"), settings: subtitlesSchema }),
]);
export type JobType = "clean" | "master" | "subtitles";
