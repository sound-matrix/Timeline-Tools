import type { Arrangement } from "./arrangement.ts";
import type { Cue } from "./subtitles.ts";

/** Same source-to-output timing as the studio worker's arrangement_cues. */
export function studioCues(a: Arrangement): Cue[] {
  return a.regions
    .flatMap((r) => {
      if (r.mute) return [];
      return (r.lines ?? []).flatMap((line) => {
        const start = Math.max(r.src_start, line.src_start);
        const end = Math.min(r.src_end, line.src_end);
        const text = a.lines[line.line]?.text;
        return end > start && text
          ? [
              {
                start: r.start + start - r.src_start,
                end: r.start + end - r.src_start,
                text,
              },
            ]
          : [];
      });
    })
    .sort((a, b) => a.start - b.start);
}

/** Paragraphs retain cue boundaries; correcting text never guesses new timings. */
export function editedStudioCues(cues: Cue[], text: string): Cue[] {
  const paragraphs = text.trim().split(/\n[ \t]*\n/);
  if (paragraphs.length !== cues.length || !text.trim())
    throw Error(
      "Keep one paragraph per subtitle, separated by a blank line. Use Editor Studio to change timing.",
    );
  return cues.map((cue, i) => ({ ...cue, text: paragraphs[i].trim() }));
}
