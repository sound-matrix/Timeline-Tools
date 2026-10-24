import { arrangementSchema } from "./arrangement.ts";
import { z } from "zod";
// Long recordings stay bounded by the existing plan/file limits and 4h render budget.
const time = z.number().finite().min(0).max(14400);
export const transcriptSchema = z
  .object({
    speakers: z
      .array(
        z
          .object({
            id: z.string().regex(/^s\d{1,3}$/),
            name: z.string().min(1).max(60),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    words: z
      .array(
        z
          .object({
            w: z.string().max(300),
            start: time,
            end: time,
            speaker: z.string(),
            conf: z.number().finite().min(0).max(1),
          })
          .strict()
          .refine((w) => w.end > w.start, "Invalid word timing"),
      )
      .min(1)
      .max(60000),
    segments: z
      .array(
        z
          .object({
            text: z.string().max(5000),
            start: time,
            end: time,
            speaker: z.string(),
          })
          .strict(),
      )
      .max(20000),
    method: z.string().max(80),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ids = new Set(t.speakers.map((s) => s.id));
    if (
      ids.size !== t.speakers.length ||
      t.words.some(
        (w, i) =>
          !ids.has(w.speaker) || (i > 0 && w.start < t.words[i - 1].start),
      ) ||
      t.segments.some((s) => !ids.has(s.speaker) || s.end <= s.start)
    )
      ctx.addIssue({ code: "custom", message: "Invalid transcript" });
  });
export type PodcastTranscript = z.infer<typeof transcriptSchema>;
const range = { start: time, end: time };
const operationSchema = z
  .discriminatedUnion("op", [
    z.object({ op: z.literal("mute"), ...range }).strict(),
    z.object({ op: z.literal("delete"), ...range }).strict(),
    z
      .object({
        op: z.literal("bleep"),
        ...range,
        db: z.number().finite().min(-60).max(0),
      })
      .strict(),
    z
      .object({
        op: z.literal("insert"),
        at: time,
        duration: z.number().finite().positive().max(60),
      })
      .strict(),
  ])
  .refine(
    (o) => o.op === "insert" || o.end > o.start,
    "Select a nonempty range",
  );
export const editsSchema = z
  .object({
    timeline: arrangementSchema.optional(),
    operations: z.array(operationSchema).max(2000),
    corrections: z.record(
      z.string().regex(/^\d{1,5}$/),
      z.string().min(1).max(300),
    ),
    speaker_names: z.record(
      z.string().regex(/^s\d{1,3}$/),
      z.string().min(1).max(60),
    ),
  })
  .strict();
export type PodcastEdits = z.infer<typeof editsSchema>;

export function validEdits(
  edits: PodcastEdits,
  t: PodcastTranscript,
  duration: number,
  sourceClips?: {
    id: string;
    name: string;
    duration: number;
    offset?: number;
  }[],
) {
  const ids = new Set(t.speakers.map((s) => s.id));
  return (
    (!edits.timeline ||
      (edits.timeline.unplaced.length === 0 &&
        (sourceClips
          ? JSON.stringify(edits.timeline.clips) === JSON.stringify(sourceClips)
          : edits.timeline.clips.length === 1 &&
            edits.timeline.clips[0].id === "source" &&
            Math.abs(edits.timeline.clips[0].duration - duration) < 0.001))) &&
    Object.keys(edits.corrections).every((k) => Number(k) < t.words.length) &&
    Object.keys(edits.speaker_names).every((k) => ids.has(k)) &&
    edits.operations.every((o) =>
      o.op === "insert" ? o.at <= duration : o.end <= duration,
    ) &&
    editedDuration(duration, edits) > 0 &&
    editedDuration(duration, edits) <= 14400
  );
}
export function cutRanges(edits: PodcastEdits): [number, number][] {
  const cuts = edits.operations
    .filter((o) => o.op === "delete")
    .map((o) => [o.start, o.end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const c of cuts) {
    const last = merged.at(-1);
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else merged.push([...c]);
  }
  return merged;
}
export function remapTime(
  value: number,
  edits: PodcastEdits,
  includeBoundary = true,
) {
  const cuts = cutRanges(edits);
  return (
    value -
    cuts.reduce((n, [a, b]) => n + Math.max(0, Math.min(value, b) - a), 0) +
    edits.operations.reduce(
      (n, o) =>
        n +
        (o.op === "insert" &&
        (includeBoundary ? o.at <= value : o.at < value) &&
        !cuts.some(([a, b]) => o.at > a && o.at < b)
          ? o.duration
          : 0),
      0,
    )
  );
}
export function editedDuration(duration: number, edits: PodcastEdits) {
  return Number(
    remapTime(edits.timeline?.duration ?? duration, edits).toFixed(6),
  );
}
export function outputToSource(
  value: number,
  duration: number,
  edits: PodcastEdits,
): { time: number; gap: boolean } {
  const cuts = cutRanges(edits);
  const inserts = edits.operations
    .filter((o) => o.op === "insert")
    .filter((o) => !cuts.some(([a, b]) => o.at > a && o.at < b));
  const points = [
    0,
    duration,
    ...cuts.flat(),
    ...inserts.map((o) => o.at),
  ].sort((a, b) => a - b);
  let output = 0;
  for (let i = 0; i < points.length; i++) {
    const start = points[i];
    if (i && start === points[i - 1]) continue;
    const gap = inserts
      .filter((o) => o.at === start)
      .reduce((n, o) => n + o.duration, 0);
    if (value < output + gap) return { time: start, gap: true };
    output += gap;
    const end = points.find((p) => p > start) ?? duration;
    if (cuts.some(([a, b]) => start >= a && end <= b)) continue;
    if (value <= output + end - start)
      return { time: start + Math.max(0, value - output), gap: false };
    output += end - start;
  }
  return { time: duration, gap: false };
}
export function editedWords(t: PodcastTranscript, edits: PodcastEdits) {
  const cuts = cutRanges(edits);
  return t.words.flatMap((w, i) =>
    cuts.some(([a, b]) => w.start < b && w.end > a)
      ? []
      : [
          {
            ...w,
            w: edits.corrections[String(i)] ?? w.w,
            start: remapTime(w.start, edits),
            end: remapTime(w.end, edits, false),
          },
        ],
  );
}
