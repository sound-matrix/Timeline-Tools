import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jobSchema } from "../lib/settings.ts";
import { processingSettings } from "../lib/processing-form.ts";
const fixture = JSON.parse(
  readFileSync("tests/fixtures/processing-settings.json", "utf8"),
);
const cases = fixture.cases.map((c) => {
  if (c.type !== "master") return c;
  const settings = structuredClone(fixture.master);
  for (const p of c.patch) {
    const parts = p.path.split(".");
    const key = parts.pop();
    const parent = parts.reduce((o, k) => o[k], settings);
    if (p.remove) delete parent[key];
    else parent[key] = p.value;
  }
  return { ...c, settings };
});
for (const c of cases)
  test(`settings: ${c.name}`, () => {
    assert.equal(jobSchema.safeParse(c).success, c.valid);
  });
test("form starts invalid for every tool and never converts blanks to zero", () => {
  for (const type of ["clean", "master", "subtitles"]) {
    assert.equal(
      jobSchema.safeParse({ type, settings: processingSettings(type, {}) })
        .success,
      false,
    );
  }
  const empty = processingSettings("master", { loudness: true, lufs: "" });
  assert.equal(empty.loudness.lufs, undefined);
  assert.equal(
    jobSchema.safeParse({ type: "master", settings: empty }).success,
    false,
  );
  const selected = processingSettings("master", {
    loudness: true,
    lufs: "-18.5",
    eq: false,
    gain0: "9",
  });
  assert.equal(
    jobSchema.safeParse({ type: "master", settings: selected }).success,
    true,
  );
  assert.deepEqual(selected.eq, { enabled: false });
});
test("nonfinite master numbers are rejected", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const settings = structuredClone(cases[0].settings);
    settings.loudness.lufs = value;
    assert.equal(
      jobSchema.safeParse({ type: "master", settings }).success,
      false,
    );
  }
});

test("cleanup dropdowns require explicit method and amounts and map Off to bypass", () => {
  const valid = (choices) =>
    jobSchema.safeParse({
      type: "clean",
      settings: processingSettings("clean", choices),
    }).success;
  assert.equal(valid({ noise: true }), false);
  assert.equal(
    valid({ noise: true, noiseMethod: "speech", noiseAmount: "" }),
    false,
  );
  assert.equal(valid({ voice: true, hum: true }), false);
  assert.equal(valid({ voice: true, hum: true, humAmount: "0" }), true);
  assert.equal(valid({ hum: true, humAmount: "0" }), false);
  assert.equal(valid({ noise: true, noiseAmount: "60" }), false);
  assert.equal(
    valid({
      noise: true,
      noiseMethod: "speech",
      noiseAmount: "0",
      voice: true,
    }),
    true,
  );
  const choices = {
    noise: true,
    noiseMethod: "speech_music",
    noiseAmount: "60",
    hum: true,
    humAmount: "30",
    reverb: true,
    reverbAmount: "100",
  };
  assert.equal(valid(choices), true);
  assert.deepEqual(processingSettings("clean", choices), {
    noise: { enabled: true, method: "speech_music", amount: 60 },
    hum: { enabled: true, amount: 30 },
    reverb: { enabled: true, amount: 100 },
    voice: false,
  });
  assert.deepEqual(
    processingSettings("clean", { ...choices, noise: false, hum: false }).noise,
    { enabled: false },
  );
  assert.equal(valid({ voice: true }), true);
});
