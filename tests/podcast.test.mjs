import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { withDefaults } from "../lib/defaults.ts";
import { jobSchema } from "../lib/settings.ts";
import {
  transcriptSchema,
  editsSchema,
  editedDuration,
  editedWords,
  remapTime,
  outputToSource,
  validEdits,
} from "../lib/podcast.ts";
const transcript = {
  speakers: [
    { id: "s0", name: "Host" },
    { id: "s1", name: "Guest" },
  ],
  words: [
    { w: "Hello", start: 0, end: 1, speaker: "s0", conf: 0.9 },
    { w: "world", start: 1, end: 2, speaker: "s0", conf: 0.8 },
    { w: "welcome", start: 4, end: 5, speaker: "s1", conf: 0.9 },
  ],
  segments: [],
  method: "synthetic",
};
const edits = {
  operations: [
    { op: "delete", start: 1, end: 3 },
    { op: "delete", start: 2, end: 4 },
    { op: "insert", at: 5, duration: 1 },
    { op: "mute", start: 0, end: 1 },
    { op: "bleep", start: 4, end: 5, db: -12 },
  ],
  corrections: { 2: "again" },
  speaker_names: { s1: "Visitor" },
};
test("Podcast defaults preserve strictness and mirror Python", () => {
  const cases = [
    { type: "podcast", settings: {} },
    {
      type: "podcast",
      settings: {
        mode: "mics",
        speakers: 2,
        cleanup: { noise: { enabled: true } },
      },
    },
    { type: "podcast_export", settings: { revision: 1 } },
    {
      type: "podcast_export",
      settings: {
        revision: 2,
        formats: ["wav"],
        wav: { bit_depth: "32f", sample_rate: 44100 },
        speaker_labels: true,
      },
    },
  ];
  for (const c of cases)
    assert.equal(
      jobSchema.safeParse({ ...c, settings: withDefaults(c.type, c.settings) })
        .success,
      true,
    );
  const result = spawnSync(
    "python",
    [
      "-c",
      "import json,sys;from workers.defaults import with_defaults;print(json.dumps([with_defaults(c['type'],c['settings']) for c in json.load(sys.stdin)]))",
    ],
    { input: JSON.stringify(cases), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    cases.map((c) => withDefaults(c.type, c.settings)),
  );
  for (const partial of [
    { speakers: 0 },
    { mode: "unsupported" },
    { cleanup: null },
  ])
    assert.equal(
      jobSchema.safeParse({
        type: "podcast",
        settings: withDefaults("podcast", partial),
      }).success,
      false,
    );
});
test("EDL unions overlapping cuts, remaps subtitle endpoints and insertion gaps identically to Python", () => {
  assert.equal(transcriptSchema.safeParse(transcript).success, true);
  assert.equal(editsSchema.safeParse(edits).success, true);
  assert.equal(validEdits(edits, transcript, 6), true);
  assert.equal(editedDuration(6, edits), 4);
  assert.equal(remapTime(4, edits), 1);
  const words = editedWords(transcript, edits);
  assert.equal(words.length, 2);
  assert.equal(words[1].w, "again");
  assert.deepEqual([words[1].start, words[1].end], [1, 2]);
  assert.deepEqual(outputToSource(2.5, 6, edits), { time: 5, gap: true });
  const result = spawnSync(
    "python",
    [
      "-c",
      "import sys,json;from workers.podcast import edited_words,spans;x=json.load(sys.stdin);print(json.dumps({'words':edited_words(x['transcript'],x['edits']),'duration':spans(6,x['edits'])[1]}))",
    ],
    { input: JSON.stringify({ transcript, edits }), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { words, duration: 4 });
  assert.equal(
    validEdits({ ...edits, corrections: { 999: "bad" } }, transcript, 6),
    false,
  );
  assert.equal(
    transcriptSchema.safeParse({
      ...transcript,
      words: [{ ...transcript.words[0], start: Infinity }],
    }).success,
    false,
  );
});
