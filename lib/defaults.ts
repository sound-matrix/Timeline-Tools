/** Submit-time defaults only. Controls stay blank; workers/defaults.json is the
 * canonical, versioned fixture also loaded by the Python worker. Never coerce
 * null, NaN, or an explicit out-of-range value into a valid choice. */
import config from "../workers/defaults.json" with { type: "json" };
export const DEFAULTS = config.defaults;
export const STAGE_DEFAULTS = config.stages;
type ObjectValue = Record<string, unknown>;
function object(v: unknown): v is ObjectValue {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function merge(base: ObjectValue, partial: ObjectValue): ObjectValue {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) continue;
    Object.defineProperty(out, key, {
      value:
        object(value) && Object.hasOwn(out, key) && object(out[key])
          ? merge(out[key], value)
          : value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}
export function withDefaults(type: string, partial: unknown): unknown {
  if (typeof type !== "string") return partial;
  if (type === "podcast") {
    if (partial !== undefined && !object(partial)) return partial;
    const p = partial as ObjectValue | undefined;
    return {
      ...DEFAULTS.podcast,
      ...p,
      cleanup: withDefaults("clean", p?.cleanup),
    };
  }
  if (type === "podcast_export") {
    const merged = withDefaults("studio_export", partial);
    return object(merged) ? { ...DEFAULTS.podcast_export, ...merged } : merged;
  }

  if (!object(partial))
    return partial === undefined ? withDefaults(type, {}) : partial;
  // Legacy queue settings are already complete and must retain their meaning.
  if (type === "clean" && "strength" in partial) return partial;
  if (type === "studio_export") {
    const formats =
      Array.isArray(partial.formats) && partial.formats.length === 0
        ? DEFAULTS.export.formats
        : (partial.formats ?? DEFAULTS.export.formats);
    const base: ObjectValue = {
      subtitles: [],
      missing_lines: "exclude",
      formats,
    };
    if (Array.isArray(formats))
      for (const fmt of formats) {
        if (fmt === "mp3" || fmt === "wav")
          base[fmt] = DEFAULTS.export[fmt as "mp3" | "wav"];
      }
    return merge(base, { ...partial, formats });
  }
  if (!Object.hasOwn(DEFAULTS, type) || type === "export") return partial;
  const base = DEFAULTS[type as "studio" | "clean" | "master" | "subtitles"];
  const p = { ...partial };
  if (type === "subtitles" && Array.isArray(p.formats) && !p.formats.length)
    delete p.formats;
  if (type === "clean" || type === "master") {
    const keys =
      type === "clean"
        ? ["noise", "hum", "reverb"]
        : ["loudness", "limiter", "compressor", "eq"];
    const selected =
      keys.some((k) => object(p[k]) && p[k].enabled === true) ||
      (type === "clean" && p.voice === true);
    if (
      !selected &&
      keys.every(
        (k) =>
          p[k] === undefined ||
          (object(p[k]) &&
            p[k].enabled === false &&
            Object.keys(p[k]).length === 1),
      ) &&
      (p.voice === undefined || p.voice === false)
    ) {
      for (const k of [...keys, ...(type === "clean" ? ["voice"] : [])])
        delete p[k];
    }
  }
  const result = merge(base, p);
  for (const [key, value] of Object.entries(p)) {
    if (!object(value) || !Object.hasOwn(STAGE_DEFAULTS, key)) continue;
    const stage = merge(
      STAGE_DEFAULTS[key as keyof typeof STAGE_DEFAULTS],
      value,
    );
    const fallback = (base as ObjectValue)[key];
    const enabled =
      value.enabled ?? (object(fallback) ? fallback.enabled : false);
    // Disabled stages are strict shapes. Keep user-supplied extra keys to reject them.
    result[key] =
      enabled === false
        ? merge(
            { enabled: false },
            Object.fromEntries(
              Object.entries(value).filter(
                ([k, v]) =>
                  k === "enabled" ||
                  (v !== undefined && !(Array.isArray(v) && !v.length)),
              ),
            ),
          )
        : stage;
    if (
      object(result[key]) &&
      result[key].enabled === true &&
      key === "subtitles" &&
      Array.isArray(result[key].formats) &&
      !result[key].formats.length
    )
      result[key].formats = ["srt"];
  }
  if (
    object(result.eq) &&
    result.eq.enabled === true &&
    Array.isArray(result.eq.bands)
  ) {
    const bands = result.eq.bands;
    result.eq.bands = bands.every(
      (b) => object(b) && b.enabled === false && Object.keys(b).length === 1,
    )
      ? STAGE_DEFAULTS.eq.bands
      : bands.map((b) =>
          object(b) && b.enabled === true ? merge({ gain: 0 }, b) : b,
        );
  }
  if (type === "studio" && result.has_bed === true) {
    if (result.ducking_db === undefined) result.ducking_db = 12;
    if (result.bed_fit === undefined) result.bed_fit = "trim";
  }
  return result;
}
export const DEFAULT_HELP = {
  studio:
    "Blank settings use: whole clips, gap 300 ms, normal matching, dialogue −18 LUFS, master −16 LUFS, room tone off, subtitles off; with a bed: 12 dB ducking, trim. Enabled room tone defaults to 60%; enabled subtitles to SRT.",
  clean:
    "With no stages selected: speech noise removal 60%, hum 30%, reverb off, voice on. Enabled stages with blank amounts use 60%; noise method defaults to speech.",
  master:
    "With no stages selected: −16 LUFS and −1 dBTP limiter (soft knee, 180 ms), compressor and EQ off. Blank settings in enabled stages use the documented defaults.",
  subtitles: "Blank settings use automatic language detection and SRT.",
};
