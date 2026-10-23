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
  .strict();
export const masterSchema = z
  .object({
    eq: z.array(z.number().min(-12).max(12)).length(5),
    threshold: z.number().min(-40).max(0),
    ratio: z.number().min(1).max(10),
    ceiling: z.enum(["-1", "-2", "-0.3"]),
    lufs: z.enum(["-14", "-16", "-23"]),
  })
  .strict();
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
