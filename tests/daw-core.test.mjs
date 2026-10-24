import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arrangementSchema, uniqueSourceSeconds } from "../lib/arrangement.ts";
import {
  CommandHistory,
  deleteRegions,
  fadeValue,
  panGains,
  snapTime,
  splitRegions,
  rulerStamp,
} from "../lib/daw/commands.ts";
import {
  podcastRenderArrangement,
  podcastPlan,
} from "../lib/daw/podcast-audio.ts";
const legacy = JSON.parse(
  readFileSync("tests/fixtures/daw-arrangement.json", "utf8"),
);
const fixture = () => arrangementSchema.parse(legacy);
test("v1 migration retains positions, trims and legacy pan; v2 round trips all editable metadata", () => {
  const a = fixture();
  assert.equal(a.version, 2);
  assert.equal(a.pan_law, "legacy");
  for (let i = 0; i < a.regions.length; i++) {
    for (const k of ["src_start", "src_end", "start", "gain_db"])
      assert.equal(a.regions[i][k], legacy.regions[i][k]);
    assert.equal(a.regions[i].lines.length, 1);
  }
  a.pan_law = "equal_power";
  a.lanes[0].pan = 0.5;
  a.lanes[0].height = 180;
  a.master.gain_db = -3;
  a.markers = [{ id: "m0", time: 1, name: "Opening", color: "#FFFFFF" }];
  a.regions[0].fade_in = 0.2;
  assert.deepEqual(arrangementSchema.parse(JSON.parse(JSON.stringify(a))), a);
});
test("200-step command history, branching, split trims/captions and ripple union", () => {
  let a = fixture();
  const history = new CommandHistory();
  for (let i = 0; i < 230; i++)
    a = history.execute("gain", a, {
      ...a,
      master: { ...a.master, gain_db: i % 20 },
    });
  assert.equal(history.past.length, 200);
  const last = a.master.gain_db;
  a = history.undo(a);
  assert.notEqual(a.master.gain_db, last);
  a = history.redo(a);
  assert.equal(a.master.gain_db, last);
  a = history.undo(a);
  history.execute("new", a, { ...a, snap: !a.snap });
  assert.equal(history.future.length, 0);
  const split = splitRegions(fixture(), ["r0"], 1);
  assert.equal(split.regions.length, 3);
  assert.deepEqual(
    split.regions.slice(0, 2).map((r) => [r.src_start, r.src_end, r.start]),
    [
      [0, 1, 0],
      [1, 2, 1],
    ],
  );
  assert.equal(uniqueSourceSeconds(split.regions), 4);
  const r = fixture().regions[0];
  const b = {
    ...fixture(),
    regions: [
      { ...r, id: "one", start: 0, src_end: 2 },
      { ...r, id: "two", start: 1, src_end: 2 },
      { ...r, id: "three", start: 5 },
    ],
  };
  assert.equal(deleteRegions(b, ["one", "two"], true).regions[0].start, 2);
});
test("snap grids, edge attraction, musical ruler and equal power pan law", () => {
  const a = fixture();
  for (const fps of [24, 25, 30])
    assert.ok(
      Math.abs(
        snapTime(a, 1.234, `frames${fps}`, 50) - Math.round(1.234 * fps) / fps,
      ) < 1e-10,
    );
  assert.equal(snapTime(a, 1.07, "seconds", 50), 1);
  assert.equal(snapTime(a, 1.2345, "milliseconds", 50), 1.235);
  assert.equal(snapTime(a, 2.01, "edges", 50), 2);
  assert.equal(rulerStamp(2, "bars", a), "2|1|000");
  for (const pan of [-1, -0.3, 0, 0.7, 1]) {
    const [l, r] = panGains(pan);
    assert.ok(Math.abs(l * l + r * r - 1) < 1e-12);
  }
  assert.deepEqual(panGains(0, "legacy"), [1, 1]);
});
test("linear/equal-power fades use identical formulas and validation rejects malformed v2", () => {
  const a = fixture(),
    r = { ...a.regions[0], fade_in: 1, fade_out: 1 };
  assert.equal(fadeValue(r, 0.5), 0.5);
  assert.ok(
    Math.abs(
      fadeValue({ ...r, fade_curve: "equal_power" }, 0.5) - Math.SQRT1_2,
    ) < 1e-12,
  );
  for (const patch of [
    { tempo: 0 },
    { loop: { enabled: true, start: 2, end: 1 } },
    { master: { gain_db: Infinity, inserts: [] } },
    { derived_clips: [{ id: "bad", source: "foreign" }] },
  ])
    assert.equal(
      arrangementSchema.safeParse({ ...a, ...patch }).success,
      false,
    );
});
test("podcast source-bound plan remaps cuts and inserted silence without chopping saved clips", () => {
  const a = fixture();
  a.clips = [{ id: "source", name: "Podcast", duration: 8 }];
  a.regions = [{ ...a.regions[0], clip: "source", src_end: 8, lines: [] }];
  a.missing = [];
  a.unplaced = [];
  const edits = {
    operations: [
      { op: "delete", start: 2, end: 3 },
      { op: "insert", at: 5, duration: 0.3 },
    ],
    corrections: {},
    speaker_names: {},
  };
  const output = podcastRenderArrangement(a, edits);
  assert.equal(output.duration, 7.3);
  assert.equal(output.regions.length, 1);
  assert.equal(output.regions[0].src_end, 7.3);
  assert.ok(podcastPlan(8, edits).some((s) => s.gap && s.length === 0.3));
});

test("podcast output clock maps moved clips back to their original video position", async () => {
  const { podcastViewTime, podcastOutputTime } =
    await import("../lib/daw/podcast-audio.ts");
  const a = fixture();
  a.duration = 30;
  a.clips = [{ id: "c0", name: "Voice", duration: 8, offset: 10 }];
  a.missing = [];
  a.unplaced = [];
  a.regions = [
    {
      ...a.regions[0],
      clip: "c0",
      start: 2,
      src_start: 1,
      src_end: 5,
      lines: [],
    },
  ];
  const edits = {
    operations: [{ op: "delete", start: 11, end: 12 }],
    corrections: {},
    speaker_names: {},
  };
  const rendered = podcastRenderArrangement(a, edits);
  assert.deepEqual(podcastViewTime(a, edits, 4), { source: 13, output: 3 });
  assert.deepEqual(podcastOutputTime(a, rendered, edits, 3), {
    view: 4,
    source: 13,
    gap: false,
  });
});

test("standalone browser worker assets are syntactically valid JavaScript", async () => {
  const { Script } = await import("node:vm");
  for (const name of ["audio", "peaks", "paint"])
    assert.doesNotThrow(
      () => new Script(readFileSync(`public/daw/${name}-worker.js`, "utf8")),
    );
});
