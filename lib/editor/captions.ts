import type { Arrangement } from "../arrangement.ts";
import {
  cutRanges,
  remapTime,
  type PodcastEdits,
  type PodcastTranscript,
} from "../podcast.ts";
import { localPodcastEdits } from "../daw/podcast-audio.ts";
export function editorCaptions(
  a: Arrangement,
  rendered: Arrangement,
  transcript: PodcastTranscript,
  edits: PodcastEdits,
  span: [number, number],
) {
  const cues: { start: number; end: number; text: string }[] = [];
  for (const r of a.regions) {
    const c = a.clips.find((c) => c.id === r.clip);
    if (!c || c.asset) continue;
    const out = rendered.regions.find((q) => q.id === r.id);
    if (!out) continue;
    const e =
        c.id === "source"
          ? edits
          : localPodcastEdits(edits, c.offset ?? 0, c.duration),
      cuts = cutRanges(e);
    transcript.words.forEach((w, i) => {
      const start = w.start - (c.offset ?? 0),
        end = w.end - (c.offset ?? 0);
      if (
        start < r.src_start ||
        end > r.src_end ||
        cuts.some(([a, b]) => start < b && end > a)
      )
        return;
      const from = out.start + remapTime(start, e) - out.src_start,
        to = out.start + remapTime(end, e, false) - out.src_start;
      if (to <= span[0] || from >= span[1]) return;
      cues.push({
        start: Math.max(0, from - span[0]),
        end: Math.min(span[1] - span[0], to - span[0]),
        text: edits.corrections[String(i)] ?? w.w,
      });
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}
export function subtitleText(
  cues: { start: number; end: number; text: string }[],
  format: "srt" | "vtt",
) {
  const stamp = (time: number) => {
    const n = Math.round(time * 1000);
    return `${String(Math.floor(n / 3600000)).padStart(2, "0")}:${String(Math.floor(n / 60000) % 60).padStart(2, "0")}:${String(Math.floor(n / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(n % 1000).padStart(3, "0")}`;
  };
  return (
    (format === "vtt" ? "WEBVTT\n\n" : "") +
    cues
      .map(
        (c, i) =>
          `${format === "srt" ? String(i + 1) + "\n" : ""}${stamp(c.start)} --> ${stamp(c.end)}\n${c.text.replaceAll("-->", "→")}\n`,
      )
      .join("\n")
  );
}
