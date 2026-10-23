export type Choices = Record<string, string | boolean>;
const on = (v: Choices, key: string) => v[key] === true;
const number = (v: Choices, key: string) =>
  typeof v[key] === "string" && v[key].trim() !== "" ? Number(v[key]) : NaN;
export function processingSettings(type: string, v: Choices) {
  const stage = (key: string, fields: object) =>
    on(v, key) ? { enabled: true, ...fields } : { enabled: false };
  if (type === "clean")
    return {
      noise: on(v, "noise"),
      hum: on(v, "hum"),
      reverb: on(v, "reverb"),
      voice: on(v, "voice"),
      strength: number(v, "strength"),
    };
  if (type === "subtitles")
    return {
      language: v.language ?? "",
      formats: ["srt", "vtt"].filter((f) => on(v, f)),
    };
  return {
    loudness: stage("loudness", { lufs: number(v, "lufs") }),
    limiter: stage("limiter", {
      ceiling: number(v, "ceiling"),
      knee: v.limiterKnee,
      release: number(v, "limiterRelease"),
    }),
    compressor: stage("compressor", {
      threshold: number(v, "threshold"),
      ratio: number(v, "ratio"),
      attack: number(v, "attack"),
      release: number(v, "release"),
      knee: v.compressorKnee,
      makeup:
        v.makeup === "manual"
          ? { mode: "manual", gain: number(v, "makeupGain") }
          : { mode: v.makeup },
    }),
    eq: stage("eq", {
      bands: [0, 1, 2, 3, 4].map((i) =>
        stage(`band${i}`, { gain: number(v, `gain${i}`) }),
      ),
    }),
  };
}
