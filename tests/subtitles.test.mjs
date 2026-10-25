import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSubtitles,
  serializeSubtitles,
  validateCues,
  splitCue,
  mergeCue,
  parseTime,
  jsonCues,
  subtitleFilename,
} from "../lib/subtitles.ts";
const cues = [
  { start: 1.234, end: 3.456, text: "Hello, తెలుగు\nSecond line" },
  { start: 4, end: 5, text: "Next cue" },
];
for (const format of ["srt", "vtt"])
  test(`${format} round trip preserves millisecond timing and multilingual multiline text`, () => {
    assert.deepEqual(parseSubtitles(serializeSubtitles(cues, format)), cues);
    assert.deepEqual(
      parseSubtitles(
        "\uFEFF" + serializeSubtitles(cues, format).replaceAll("\n", "\r\n"),
      ),
      cues,
    );
  });
test("invalid syntax is rejected instead of silently dropping cues", () => {
  for (const text of [
    "not subtitles",
    "1\n00:70:00,000 --> 00:00:02,000\nHello",
    "1\n00:00:01,000 --> 00:00:02,000",
    "1\n00:00:01,000 -> 00:00:02,000\nHi",
  ])
    assert.throws(() => parseSubtitles(text));
  assert.deepEqual(parseSubtitles(""), []);
});
test("timings must be finite, positive length, ordered and non-overlapping", () => {
  assert.ok(Number.isNaN(parseTime("1:02")));
  assert.deepEqual(validateCues(cues), [[], []]);
  assert.ok(validateCues([{ start: 1, end: 1, text: "x" }])[0].length);
  assert.ok(validateCues([{ start: NaN, end: 2, text: "x" }])[0].length);
  assert.ok(
    validateCues([
      { start: 0, end: 3, text: "x" },
      { start: 2, end: 4, text: "y" },
    ])[1].length,
  );
  assert.ok(validateCues([{ start: 0, end: 1, text: "a\n\nb" }])[0].length);
  assert.deepEqual(
    validateCues([
      { start: 0, end: 1, text: "a" },
      { start: 1, end: 2, text: "b" },
    ]),
    [[], []],
  );
});
test("split and merge preserve coverage without mutating input", () => {
  const source = [{ start: 1, end: 3, text: "one two three four" }];
  const split = splitCue(source, 0);
  assert.deepEqual(split, [
    { start: 1, end: 2, text: "one two" },
    { start: 2, end: 3, text: "three four" },
  ]);
  assert.deepEqual(mergeCue(split, 0), [
    { start: 1, end: 3, text: "one two\nthree four" },
  ]);
  assert.equal(source.length, 1);
  assert.deepEqual(splitCue([{ start: 0, end: 0.001, text: "a" }], 0), [
    { start: 0, end: 0.001, text: "a" },
  ]);
});
test("JSON segments, text, safe ASS style and filenames", () => {
  assert.deepEqual(
    jsonCues(JSON.parse(serializeSubtitles(cues, "json"))),
    cues,
  );
  assert.throws(() =>
    jsonCues({ segments: [{ start: "1", end: 2, text: "a" }] }),
  );
  assert.equal(
    serializeSubtitles(cues, "txt"),
    "Hello, తెలుగు\nSecond line\n\nNext cue\n",
  );
  assert.match(
    serializeSubtitles(cues, "ass"),
    /Dialogue: 0,0:00:01.23,0:00:03.46,Default/,
  );
  assert.ok(
    !serializeSubtitles(
      [{ start: 0, end: 1, text: "{\\pos(0,0)}hello" }],
      "ass",
    ).includes("{\\pos"),
  );
  assert.equal(
    subtitleFilename("my.film.mp4", "Telugu", "vtt"),
    "my.film.te.vtt",
  );
});
