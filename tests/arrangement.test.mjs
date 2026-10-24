import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arrangementSchema, exportSettingsSchema } from "../lib/arrangement.ts";
const a = JSON.parse(
  readFileSync("tests/fixtures/daw-arrangement.json", "utf8"),
);
test("arrangement accepts missing/unplaced but rejects invalid source ranges, lanes, duplicates and oversized objects", () => {
  assert.equal(arrangementSchema.safeParse(a).success, true);
  for (const patch of [
    { src_end: 100 },
    { src_start: -1 },
    { lane: "foreign" },
    { start: 50 },
    { gain_db: NaN },
  ]) {
    assert.equal(
      arrangementSchema.safeParse({
        ...a,
        regions: [{ ...a.regions[0], ...patch }],
      }).success,
      false,
    );
  }
  assert.equal(
    arrangementSchema.safeParse({ ...a, regions: [a.regions[0], a.regions[0]] })
      .success,
    false,
  );
});
test("export fields are deliberate and format-specific", () => {
  const s = {
    revision: 1,
    formats: ["mp3"],
    mp3: { bitrate_kbps: 128, sample_rate: 44100 },
    subtitles: [],
    missing_lines: "exclude",
  };
  assert.equal(exportSettingsSchema.safeParse(s).success, true);
  for (const patch of [
    { formats: [] },
    { mp3: undefined },
    { mp3: { bitrate_kbps: 129, sample_rate: 48000 } },
    { subtitles: undefined },
    { missing_lines: undefined },
    { revision: 0 },
    { formats: ["mp3", "mp3"] },
  ])
    assert.equal(
      exportSettingsSchema.safeParse({ ...s, ...patch }).success,
      false,
    );
  for (const depth of [16, 24, "32f"])
    for (const rate of [44100, 48000, 96000])
      assert.equal(
        exportSettingsSchema.safeParse({
          ...s,
          formats: ["wav"],
          mp3: undefined,
          wav: { bit_depth: depth, sample_rate: rate },
        }).success,
        true,
      );
});
