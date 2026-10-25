import test from "node:test";
import assert from "node:assert/strict";
import {
  effectDefaults,
  EFFECTS,
  effectPresets,
  validEffect,
} from "../lib/daw/effects.ts";
import { arrangementSchema, pluginSlotSchema } from "../lib/arrangement.ts";
import { blankArrangement, importPlacement } from "../lib/editor/model.ts";
import { moveSection } from "../lib/daw/sections.ts";
import { spawnSync } from "node:child_process";
const id = "33333333-3333-4333-8333-333333333333";
const slot = (type) => ({
  id: "fx_" + type,
  type,
  enabled: true,
  parameters: effectDefaults(type),
});
test("all effect parameters survive strict arrangement serialization, including order and bypass", () => {
  let a = importPlacement(
    blankArrangement(id),
    { id: "voice", name: "voice.wav", duration: 8 },
    { time: 0 },
  );
  a.lanes[0].inserts = Object.keys(EFFECTS).map(slot);
  a.lanes[0].inserts[1].enabled = false;
  a.lanes[0].height = 96;
  a.lanes[0].color = "#F472B6";
  a.master.inserts = [slot("limiter")];
  a.regions[0].reverse = true;
  a.regions[0].inserts = [slot("eq")];
  assert.deepEqual(arrangementSchema.parse(JSON.parse(JSON.stringify(a))), a);
  for (const value of [NaN, Infinity, -1000, 1000])
    assert.equal(
      pluginSlotSchema.safeParse({
        ...slot("compressor"),
        parameters: { ...effectDefaults("compressor"), ratio: value },
      }).success,
      false,
    );
  assert.equal(
    pluginSlotSchema.safeParse({
      ...slot("delay"),
      parameters: { ...effectDefaults("delay"), unknown: 4 },
    }).success,
    false,
  );
  const py = spawnSync(
    "python",
    [
      "-c",
      "import json,sys;from workers.effect_contract import validate_slots;print(json.dumps(validate_slots(json.load(sys.stdin))))",
    ],
    {
      input: JSON.stringify(a.lanes[0].inserts),
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: process.cwd() },
    },
  );
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), a.lanes[0].inserts);
});
test("moving/duplicating a section isolates crossing clips and keeps outside audio intact", () => {
  let a = importPlacement(
    blankArrangement(id),
    { id: "voice", name: "voice.wav", duration: 8 },
    { time: 0 },
  );
  a.sections = [
    { id: "a", start: 0, end: 4, name: "A", color: "#818CF8" },
    { id: "b", start: 4, end: 8, name: "B", color: "#34D399" },
  ];
  const moved = arrangementSchema.parse(moveSection(a, "a", 1));
  assert.deepEqual(
    moved.sections.map((s) => [s.id, s.start, s.end]),
    [
      ["b", 0, 4],
      ["a", 4, 8],
    ],
  );
  assert.equal(moved.regions.length, 2);
  assert.equal(moved.regions.find((r) => r.src_start === 0).start, 4);
  assert.equal(moved.regions.find((r) => r.src_start === 4).start, 0);
  const duplicated = arrangementSchema.parse(moveSection(a, "a", 1, true));
  assert.equal(duplicated.regions.length, 3);
  assert.equal(duplicated.sections[1].start, 4);
  assert.equal(duplicated.sections[2].start, 8);
});

test("every named preset stays inside its effect parameter contract", () => {
  for (const type of Object.keys(EFFECTS))
    for (const preset of effectPresets(type))
      assert.equal(validEffect(type, preset.parameters), true, preset.name);
});
