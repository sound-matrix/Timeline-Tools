import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jobSchema } from "../lib/settings.ts";
import { processingSettings } from "../lib/processing-form.ts";
import {
  parseScript,
  subtitleText,
  alignmentReportSchema,
} from "../lib/audio-studio.ts";
const fixture = JSON.parse(
  readFileSync("tests/fixtures/studio-settings.json", "utf8"),
);
const valid = (settings) =>
  jobSchema.safeParse({ type: "studio", settings }).success;
test("studio requires explicit choices, preserves zeros and rejects blank/nonfinite numbers", () => {
  assert.equal(valid(fixture), true);
  assert.equal(valid(processingSettings("studio", {})), false);
  const choices = {
    lineGap: "250",
    matchStrictness: "normal",
    bedFit: "trim",
    dialogueLufs: "-23",
    masterLufs: "-16",
    hasBed: true,
    duckingDb: "0",
    roomTone: "on",
    roomAmount: "0",
    subtitles: "on",
    srt: true,
    vtt: true,
  };
  assert.deepEqual(processingSettings("studio", choices), fixture);
  for (const key of ["dialogueLufs", "masterLufs", "duckingDb", "roomAmount"]) {
    for (const blank of ["", " ", "\t\n"]) {
      const settings = processingSettings("studio", {
        ...choices,
        [key]: blank,
      });
      assert.equal(valid(settings), false, key);
      assert.equal(valid(JSON.parse(JSON.stringify(settings))), false, key);
    }
  }
  for (const key of ["dialogue_lufs", "master_lufs", "ducking_db"]) {
    for (const value of [NaN, Infinity, -Infinity, "0", true, null])
      assert.equal(valid({ ...fixture, [key]: value }), false);
  }
});
test("studio refines bed, subtitle formats and room tone state", () => {
  assert.equal(valid({ ...fixture, has_bed: false }), false);
  assert.equal(valid({ ...fixture, ducking_db: undefined }), false);
  assert.equal(valid({ ...fixture, ducking_db: -1 }), false);
  for (const formats of [[], ["srt", "srt"], ["txt"]])
    assert.equal(
      valid({ ...fixture, subtitles: { enabled: true, formats } }),
      false,
    );
  assert.equal(
    valid({ ...fixture, subtitles: { enabled: false, formats: ["srt"] } }),
    false,
  );
  assert.equal(
    valid({ ...fixture, room_tone: { enabled: false, amount: 0 } }),
    false,
  );
  assert.equal(
    valid({ ...fixture, room_tone: { enabled: true, amount: 101 } }),
    false,
  );
  const noBed = {
    ...fixture,
    has_bed: false,
    room_tone: { enabled: false },
    subtitles: { enabled: false },
  };
  delete noBed.ducking_db;
  delete noBed.bed_fit;
  assert.equal(valid(noBed), true);
  assert.ok(Buffer.byteLength(JSON.stringify(fixture)) < 8192);
});
test("plain and timed scripts retain speaker labels and Unicode; timed exports sanitize markup", () => {
  assert.deepEqual(parseScript("Narrator: Hello\nMeera: నమస్కారం"), [
    { text: "Hello", speaker: "Narrator" },
    { text: "నమస్కారం", speaker: "Meera" },
  ]);
  const lines = parseScript(
    "WEBVTT\n\n00:01.000 --> 00:02.500\n<b>Meera:</b> నమస్కారం\n\n00:03.000 --> 00:04.000\nNarrator: Hello",
  );
  assert.equal(lines[0].start, 1);
  assert.equal(lines[0].speaker, "Meera");
  assert.match(
    subtitleText(lines, "srt"),
    /00:00:01,000 --> 00:00:02,500\nMeera: నమస్కారం/,
  );
  assert.ok(subtitleText(lines, "vtt").startsWith("WEBVTT\n"));
  assert.throws(() => subtitleText(parseScript("hello"), "srt"), /Alignment/);
  for (const script of [
    "",
    "a".repeat(65537),
    "x\n".repeat(301),
    "00:02.000 --> 00:01.000\ninvalid",
  ])
    assert.throws(() => parseScript(script));
  assert.equal(
    alignmentReportSchema.safeParse({ method: "fake" }).success,
    false,
  );
});
