import type { JobType } from "./settings";
export type Choices = Record<string, string | boolean>;
// Empty numeric fields stay missing: Number("") must never silently choose zero.
export function processingSettings(type: JobType, values: Choices) {
  const n = (key: string) =>
    typeof values[key] === "string" && String(values[key]).trim() !== ""
      ? Number(values[key])
      : undefined;
  if (type === "clean") {
    const stage = (key: string) => {
      if (values[key] !== true) return { enabled: false };
      const amount = n(`${key}Amount`);
      // A checked toggle alone never supplies an amount or a method.
      if (key === "noise" && !values.noiseMethod)
        return { enabled: true, amount, method: undefined };
      if (amount === 0) return { enabled: false };
      return key === "noise"
        ? { enabled: true, amount, method: values.noiseMethod }
        : { enabled: true, amount };
    };
    return {
      noise: stage("noise"),
      hum: stage("hum"),
      reverb: stage("reverb"),
      voice: values.voice === true,
    };
  }
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
