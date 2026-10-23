import { z } from "zod";

export const STUDIO_MAX_BYTES = 250 * 1024 * 1024;
export const SCRIPT_MAX_BYTES = 65536;
export type ScriptLine = {
  text: string;
  speaker: string;
  start?: number;
  end?: number;
};
const clock = (s: string) =>
  s
    .replace(",", ".")
    .split(":")
    .reduce((n, v) => n * 60 + Number(v), 0);

// Preview and timed-script export only. The worker independently validates the bundle.
export function parseScript(input: string): ScriptLine[] {
  if (new TextEncoder().encode(input).length > SCRIPT_MAX_BYTES)
    throw new Error("Script must be at most 64 KB.");
  const text = input
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .trim();
  const lines: ScriptLine[] = [];
  function add(value: string, start?: number, end?: number) {
    value = value
      .replace(/<[^>]*>/g, "")
      .replace(/-->/g, "→")
      .replace(/\s+/g, " ")
      .trim();
    if (!value) return;
    const match = value.match(/^([^:]{1,60}):\s*(.+)$/);
    lines.push({
      text: match?.[2] ?? value,
      speaker: match?.[1].trim() ?? "",
      ...(start !== undefined ? { start, end } : {}),
    });
  }
  if (text.includes("-->")) {
    for (const block of text.split(/\n\s*\n/)) {
      const rows = block.split("\n");
      const i = rows.findIndex((r) => r.includes("-->"));
      if (i < 0) continue;
      const match = rows[i].match(
        /^\s*((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/,
      );
      if (!match) throw new Error("Check the script timestamps.");
      const start = clock(match[1]),
        end = clock(match[2]);
      if (
        !Number.isFinite(end) ||
        end <= start ||
        end > 86400 ||
        (lines.length && start < (lines.at(-1)?.end ?? 0))
      )
        throw new Error(
          "Script cues must be ordered, non-overlapping and shorter than 24 hours.",
        );
      add(rows.slice(i + 1).join(" "), start, end);
    }
  } else for (const line of text.split("\n")) add(line);
  if (
    !lines.length ||
    lines.length > 300 ||
    lines.some((l) => l.text.length > 1000)
  )
    throw new Error("Use 1–300 script lines, up to 1,000 characters per line.");
  return lines;
}

const seconds = z.number().finite().min(0).max(86400);
export const alignmentReportSchema = z.object({
  method: z.literal("heuristic-v1"),
  duration: seconds.positive(),
  note: z.string().max(1000),
  tracks: z
    .array(
      z.object({
        id: z.string().max(50),
        name: z.string().max(255),
        speaker: z.string().max(60),
      }),
    )
    .max(8),
  lines: z
    .array(
      z.object({
        text: z.string().max(1000),
        speaker: z.string().max(60),
        start: seconds,
        end: seconds,
        source_start: seconds,
        source_end: seconds,
        confidence: z.number().min(0).max(1),
        track: z.string().max(50),
        flags: z.array(z.string().max(100)).max(10),
      }),
    )
    .min(1)
    .max(300),
});
export type AlignmentReport = z.infer<typeof alignmentReportSchema>;

export function subtitleText(lines: ScriptLine[], format: "srt" | "vtt") {
  function stamp(s: number) {
    const ms = Math.round(s * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
  }
  return (
    (format === "vtt" ? "WEBVTT\n\n" : "") +
    lines
      .map((line, i) => {
        if (line.start === undefined || line.end === undefined)
          throw new Error("Alignment is required before export.");
        return `${i + 1}\n${stamp(line.start)} --> ${stamp(line.end)}\n${line.speaker ? line.speaker + ": " : ""}${line.text}\n`;
      })
      .join("\n") +
    "\n"
  );
}
