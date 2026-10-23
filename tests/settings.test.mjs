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
