import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DEFAULTS, withDefaults } from "../lib/defaults.ts";
import { processingSettings } from "../lib/processing-form.ts";
import { jobSchema } from "../lib/settings.ts";
const cases = ["clean", "master", "subtitles", "studio"].flatMap((type) => [
  { type, settings: {} },
  { type, settings: processingSettings(type, {}) },
]);
cases.push(
  { type: "clean", settings: processingSettings("clean", { noise: true }) },
  {
    type: "master",
    settings: processingSettings("master", { compressor: true }),
  },
  { type: "master", settings: processingSettings("master", { eq: true }) },
  {
    type: "studio",
    settings: processingSettings("studio", {
      hasBed: true,
      roomTone: "on",
      subtitles: "on",
    }),
  },
  { type: "studio_export", settings: { revision: 1 } },
  {
    type: "studio_export",
    settings: { revision: 1, formats: ["wav"], wav: {} },
  },
);
for (const c of cases)
  test(`defaults accept partial ${c.type}: ${JSON.stringify(c.settings)}`, () => {
    const settings = withDefaults(c.type, c.settings);
    const parsed = jobSchema.safeParse({ ...c, settings });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error));
  });
test("client and Python apply the identical fixture, including omitted values", () => {
  const input = JSON.stringify(cases);
  const result = spawnSync(
    "python",
    [
      "-c",
      `import sys,json; from workers.defaults import with_defaults,DEFAULTS; cases=json.load(sys.stdin); print(json.dumps({'defaults':DEFAULTS,'cases':[with_defaults(c['type'],c['settings']) for c in cases]}))`,
    ],
    { input, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.defaults, DEFAULTS);
  assert.deepEqual(
    actual.cases,
    cases.map((c) =>
      JSON.parse(JSON.stringify(withDefaults(c.type, c.settings))),
    ),
  );
});
test("explicit values are preserved and range errors stay errors", () => {
  for (const type of ["studio", "master"]) {
    const partial =
      type === "studio"
        ? { line_gap_ms: -1 }
        : { loudness: { enabled: true, lufs: 999 } };
    assert.equal(
      jobSchema.safeParse({ type, settings: withDefaults(type, partial) })
        .success,
      false,
    );
  }
  for (const value of [null, NaN, Infinity])
    assert.equal(
      jobSchema.safeParse({
        type: "studio",
        settings: withDefaults("studio", { line_gap_ms: value }),
      }).success,
      false,
    );
  assert.deepEqual(
    withDefaults("clean", {
      noise: true,
      hum: false,
      reverb: false,
      voice: false,
      strength: 50,
    }),
    { noise: true, hum: false, reverb: false, voice: false, strength: 50 },
  );
  assert.equal(
    withDefaults("studio", { room_tone: { enabled: false } }).room_tone.enabled,
    false,
  );
});
