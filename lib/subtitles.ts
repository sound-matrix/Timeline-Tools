import { subtitleText } from "./editor/captions.ts";
export type Cue = { start: number; end: number; text: string };
export type CueDraft = { start: string; end: string; text: string };
export type SubtitleFormat = "srt" | "vtt" | "txt" | "json" | "ass";
export function timestamp(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
export function parseTime(value: string): number {
  const m = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
  return m
    ? Number(m[1]) * 3600 +
        Number(m[2]) * 60 +
        Number(m[3]) +
        Number(m[4]) / 1000
    : NaN;
}
export const drafts = (cues: Cue[]): CueDraft[] =>
  cues.map((c) => ({ ...c, start: timestamp(c.start), end: timestamp(c.end) }));
export const numbers = (cues: CueDraft[]): Cue[] =>
  cues.map((c) => ({ ...c, start: parseTime(c.start), end: parseTime(c.end) }));
export function validateCues(cues: Cue[]): string[][] {
  return cues.map((c, i) => {
    const errors: string[] = [];
    if (
      !Number.isFinite(c.start) ||
      !Number.isFinite(c.end) ||
      c.start < 0 ||
      c.end > 359999.999
    )
      errors.push("Use HH:MM:SS,mmm between 00:00:00,000 and 99:59:59,999.");
    if (c.end <= c.start) errors.push("End must be after start.");
    if (i && c.start < cues[i - 1].end)
      errors.push("Start overlaps the previous cue or is out of order.");
    if (!c.text.trim()) errors.push("Enter subtitle text.");
    if (/\n\s*\n/.test(c.text))
      errors.push("Remove blank lines inside this cue.");
    return errors;
  });
}
// Parse syntax separately from timing validation so overlapping source cues remain editable.
export function parseSubtitles(source: string): Cue[] {
  let text = source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const vtt = /^WEBVTT(?:\s|$)/.test(text);
  if (vtt) text = text.replace(/^WEBVTT[^\n]*(?:\n|$)/, "").trim();
  if (!text) return [];
  return text.split(/\n[ \t]*\n/).flatMap((block, index) => {
    if (vtt && /^(NOTE|STYLE|REGION)(?:\s|$)/.test(block)) return [];
    const lines = block.split("\n");
    if (!lines[0].includes("-->")) {
      if (!vtt && !/^\d+$/.test(lines[0]))
        throw new Error(`Cue ${index + 1}: expected a numeric index.`);
      lines.shift();
    }
    const m =
      /^(\d{2,}:\d{2}:\d{2}[,.]\d{3}) --> (\d{2,}:\d{2}:\d{2}[,.]\d{3})(?:[ \t]+.*)?$/.exec(
        lines.shift() ?? "",
      );
    if (
      !m ||
      !Number.isFinite(parseTime(m[1])) ||
      !Number.isFinite(parseTime(m[2])) ||
      !lines.length
    )
      throw new Error(
        `Cue ${index + 1}: expected timestamps and subtitle text.`,
      );
    return [
      { start: parseTime(m[1]), end: parseTime(m[2]), text: lines.join("\n") },
    ];
  });
}
export function jsonCues(value: unknown): Cue[] {
  const rows = Array.isArray(value)
    ? value
    : (value as { segments?: unknown })?.segments;
  if (!Array.isArray(rows) || rows.length > 20000)
    throw new Error("Invalid segments.");
  return rows.map((c) => {
    if (
      !c ||
      typeof c.start !== "number" ||
      !Number.isFinite(c.start) ||
      typeof c.end !== "number" ||
      !Number.isFinite(c.end) ||
      typeof c.text !== "string"
    )
      throw new Error("Invalid segment.");
    return { start: c.start, end: c.end, text: c.text };
  });
}
export function splitCue(cues: Cue[], index: number): Cue[] {
  const c = cues[index];
  if (!c || Math.round((c.end - c.start) * 1000) < 2) return cues;
  const words = c.text.trim().split(/\s+/),
    cut = Math.ceil(words.length / 2);
  const midpoint = Math.round((c.start + c.end) * 500) / 1000;
  return [
    ...cues.slice(0, index),
    { ...c, end: midpoint, text: words.slice(0, cut).join(" ") },
    { ...c, start: midpoint, text: words.slice(cut).join(" ") },
    ...cues.slice(index + 1),
  ];
}
export function mergeCue(cues: Cue[], index: number): Cue[] {
  const c = cues[index],
    next = cues[index + 1];
  return !c || !next
    ? cues
    : [
        ...cues.slice(0, index),
        { start: c.start, end: next.end, text: `${c.text}\n${next.text}` },
        ...cues.slice(index + 2),
      ];
}
export function serializeSubtitles(
  cues: Cue[],
  format: SubtitleFormat,
): string {
  if (format === "srt" || format === "vtt") return subtitleText(cues, format);
  if (format === "txt") return cues.map((c) => c.text).join("\n\n") + "\n";
  if (format === "json")
    return JSON.stringify({ segments: cues }, null, 2) + "\n";
  const assTime = (n: number) =>
    timestamp(Math.round(n * 100) / 100).replace(
      /^(\d+):(\d\d):(\d\d),(\d\d)\d$/,
      (_, h, m, s, cs) => `${Number(h)}:${m}:${s}.${cs}`,
    );
  // Escape ASS control sequences so edited text cannot inject style overrides.
  const assText = (text: string) =>
    text
      .replaceAll("\\", "＼")
      .replaceAll("{", "｛")
      .replaceAll("}", "｝")
      .replaceAll("\n", "\\N");
  return (
    "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    cues
      .map(
        (c) =>
          `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${assText(c.text)}`,
      )
      .join("\n") +
    "\n"
  );
}
export function subtitleFilename(
  name: string,
  language: string,
  format: SubtitleFormat,
) {
  const lang =
    (
      {
        English: "en",
        Hindi: "hi",
        Telugu: "te",
        Tamil: "ta",
        auto: "auto",
      } as Record<string, string>
    )[language] ?? language;
  return `${name.replace(/\.[^.]+$/, "").replace(/[\\/\x00-\x1f]/g, "_")}.${lang.replace(/[^a-zA-Z0-9-]/g, "") || "und"}.${format}`;
}
