import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jobSchema } from "../lib/settings.ts";

const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/processing-settings.json", import.meta.url),
    "utf8",
  ),
);
for (const fixture of fixtures) {
  test(`settings: ${fixture.name}`, () => {
    assert.equal(
      jobSchema.safeParse({ type: fixture.type, settings: fixture.settings })
        .success,
      fixture.valid,
    );
  });
}
test("nonfinite numeric targets are rejected before serialization", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const settings = structuredClone(fixtures[0].settings);
    settings.loudness.lufs = value;
    assert.equal(
      jobSchema.safeParse({ type: "master", settings }).success,
      false,
    );
  }
});

test("empty form numbers remain missing; disabled stages discard stale choices", async () => {
  const { processingSettings } = await import("../lib/processing-options.ts");
  for (const type of ["clean", "master", "subtitles"]) {
    assert.equal(
      jobSchema.safeParse({ type, settings: processingSettings(type, {}) })
        .success,
      false,
    );
  }
  assert.ok(
    Number.isNaN(processingSettings("clean", { noise: true }).strength),
  );
  const settings = processingSettings("master", {
    loudness: true,
    lufs: "-18.5",
    ceiling: "-1.5",
    limiterKnee: "soft",
    gain0: "8",
  });
  assert.deepEqual(settings, {
    loudness: { enabled: true, lufs: -18.5 },
    limiter: { enabled: false },
    compressor: { enabled: false },
    eq: { enabled: false },
  });
  assert.equal(jobSchema.safeParse({ type: "master", settings }).success, true);
});
