import type { JobType } from "./settings";
export type Choices = Record<string, string | boolean>;
// Empty numeric fields stay missing: Number("") must never silently choose zero.
export function processingSettings(type: JobType, values: Choices) {
  const n = (key: string) =>
    typeof values[key] === "string" && String(values[key]).trim() !== ""
      ? Number(values[key])
      : undefined;
  if (type === "clean")
    return {
      noise: values.noise === true,
      hum: values.hum === true,
      reverb: values.reverb === true,
      voice: values.voice === true,
      strength: n("strength"),
    };
  if (type === "subtitles")
    return {
      language: values.language || undefined,
      formats: ["srt", "vtt"].filter((k) => values[k] === true),
    };
  return {
    loudness: values.loudness
      ? { enabled: true, lufs: n("lufs") }
      : { enabled: false },
    limiter: values.limiter
      ? {
          enabled: true,
          ceiling: n("ceiling"),
          knee: values.limiterKnee,
          release: n("limiterRelease"),
        }
      : { enabled: false },
    compressor: values.compressor
      ? {
          enabled: true,
          threshold: n("threshold"),
          ratio: n("ratio"),
          attack: n("attack"),
          release: n("release"),
          knee: values.compressorKnee,
          makeup:
            values.makeup === "manual"
              ? { mode: "manual", gain: n("makeupGain") }
              : { mode: values.makeup || undefined },
        }
      : { enabled: false },
    eq: values.eq
      ? {
          enabled: true,
          bands: [0, 1, 2, 3, 4].map((i) =>
            values[`band${i}`]
              ? { enabled: true, gain: n(`gain${i}`) }
              : { enabled: false },
          ),
        }
      : { enabled: false },
  };
}
