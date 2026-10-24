/** Map schema issue paths back to the actual form controls. */
const fields: Record<string, string> = {
  line_gap_ms: "lineGap",
  match_strictness: "matchStrictness",
  dialogue_lufs: "dialogueLufs",
  master_lufs: "masterLufs",
  ducking_db: "duckingDb",
  bed_fit: "bedFit",
  "room_tone.amount": "roomAmount",
  "room_tone.enabled": "roomTone",
  "subtitles.formats": "subtitles",
  "noise.amount": "noiseAmount",
  "noise.method": "noiseMethod",
  "hum.amount": "humAmount",
  "reverb.amount": "reverbAmount",
  "loudness.lufs": "lufs",
  "limiter.ceiling": "ceiling",
  "limiter.knee": "limiterKnee",
  "limiter.release": "limiterRelease",
  "compressor.threshold": "threshold",
  "compressor.ratio": "ratio",
  "compressor.attack": "attack",
  "compressor.release": "release",
  "compressor.knee": "compressorKnee",
  "compressor.makeup.mode": "makeup",
  "compressor.makeup.gain": "makeupGain",
};
export function fieldErrors(
  issues: { path: PropertyKey[]; message: string }[],
) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.filter((p) => p !== "settings").join(".");
    const band = /^eq.bands.(\d).gain$/.exec(path);
    errors[fields[path] ?? (band ? `gain${band[1]}` : path || "settings")] =
      issue.message;
  }
  return errors;
}
export const CONTROL_DEFAULTS: Record<string, string | number> = {
  noiseMethod: "speech",
  noiseAmount: 60,
  humAmount: 60,
  reverbAmount: 60,
  language: "auto",
  lufs: -16,
  ceiling: -1,
  limiterKnee: "soft",
  limiterRelease: 180,
  threshold: -24,
  ratio: 3,
  attack: 20,
  release: 180,
  compressorKnee: "soft",
  makeup: "auto",
  makeupGain: 0,
  lineGap: 300,
  matchStrictness: "normal",
  dialogueLufs: -18,
  masterLufs: -16,
  duckingDb: 12,
  bedFit: "trim",
  roomTone: "off",
  roomAmount: 60,
  subtitles: "off",
};
