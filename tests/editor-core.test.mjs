import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  blankArrangement,
  importPlacement,
  audioType,
  exportSpan,
} from "../lib/editor/model.ts";
import { arrangementSchema } from "../lib/arrangement.ts";
import { schedulerChunks, changedRegions } from "../lib/daw/scheduler.ts";
import { shortcutTool } from "../lib/daw/shortcuts.ts";
import { Sha256 } from "../public/daw/import-worker.js";
import { EditorSaver } from "../lib/editor/autosave.ts";
const id = "33333333-3333-4333-8333-333333333333";
test("multi-file placement creates separate tracks, existing lane snaps, clip bin leaves audio unplaced", () => {
  let a = blankArrangement(id);
  for (let i = 0; i < 3; i++)
    a = importPlacement(
      a,
      { id: "c" + i, name: "take" + i + ".wav", duration: 2 },
      { time: 1.4 },
    );
  assert.equal(a.lanes.length, 3);
  assert.equal(a.regions.length, 3);
  assert.ok(a.regions.every((r) => r.start === 1));
  a = importPlacement(
    a,
    { id: "bin", name: "bin.wav", duration: 3 },
    { time: 0, bin: true },
  );
  assert.equal(a.regions.length, 3);
  assert.equal(a.unplaced.length, 1);
  a = importPlacement(a, a.clips[0], { time: 3.2, lane: a.lanes[0].id });
  assert.equal(a.lanes.length, 3);
  assert.equal(a.regions.at(-1).start, 3);
  assert.ok(arrangementSchema.safeParse(a).success);
  assert.deepEqual(exportSpan(a, "whole"), [0, 5]);
});
test("type filters, old schema migration and optional insert hooks remain safe", () => {
  for (const ext of ["WAV", "mp3", "flac", "m4a", "aac", "AIFF", "aif", "ogg"])
    assert.ok(audioType("file." + ext));
  for (const ext of ["exe", "mp4", "wav.exe", ""])
    assert.equal(audioType("file." + ext), false);
  const a = blankArrangement(id);
  assert.deepEqual(a.master.inserts, []);
  assert.equal(a.sample_rate, 48000);
  assert.throws(() => exportSpan(a, "whole"), /Import/);
});
test("scheduler windows handle long overlaps and changed-region invalidation only", () => {
  assert.deepEqual(schedulerChunks(10, 20, 12, 8), [0, 1, 2]);
  assert.deepEqual(schedulerChunks(0, 3600, 3598, 8), [719]);
  assert.deepEqual(schedulerChunks(50, 10, 0), []);
  assert.deepEqual(
    [
      ...changedRegions(
        {
          regions: [
            { id: "a", start: 1 },
            { id: "b", start: 2 },
          ],
        },
        {
          regions: [
            { id: "a", start: 3 },
            { id: "b", start: 2 },
          ],
        },
      ),
    ],
    ["a"],
  );
  assert.equal(shortcutTool("2", "logic"), "razor");
  assert.equal(shortcutTool("F7", "protools"), "pointer");
  assert.equal(shortcutTool("3", "cubase"), "razor");
});
test("streaming SHA-256 matches standard vectors across irregular chunks", () => {
  for (const s of ["", "abc", "a".repeat(10000)]) {
    const bytes = new TextEncoder().encode(s),
      hash = new Sha256();
    for (let at = 0; at < bytes.length; at += 37)
      hash.update(bytes.subarray(at, at + 37));
    assert.equal(
      hash.digest(),
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
});
test("autosave persists offline, detects conflicts, and keep-mine rebases on the current server revision", async () => {
  let server = { revision: 1, arrangement: blankArrangement(id) },
    offline = true,
    persisted,
    conflict,
    status;
  const requests = [];
  const request = async (url, options) => {
    if (offline) throw Error("offline");
    if (options?.method === "PUT") {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.revision !== server.revision)
        return new Response("{}", { status: 409 });
      server = { revision: server.revision + 1, arrangement: body.arrangement };
      return Response.json({ revision: server.revision });
    }
    return Response.json(server);
  };
  const saver = new EditorSaver(
    id,
    server,
    {
      put: async (v) => (persisted = v),
      clear: async () => (persisted = undefined),
    },
    (v) => (status = v),
    (v) => (conflict = v),
    request,
  );
  saver.change({ ...server.arrangement, tempo: 130 });
  await assert.rejects(saver.flush(), /offline/);
  assert.equal(persisted.arrangement.tempo, 130);
  assert.equal(status, "Offline — will retry");
  offline = false;
  server = { ...server, revision: 2 };
  await assert.rejects(saver.flush(), /Choose/);
  assert.equal(conflict.revision, 2);
  await saver.resolve(conflict, true);
  assert.equal(server.arrangement.tempo, 130);
  assert.equal(server.revision, 3);
  assert.equal(persisted, undefined);
  assert.equal(status, "Saved");
  saver.close();
});

test("autosave keeps pending imports local without claiming offline or sending invalid assets", async () => {
  let persisted,
    status,
    calls = 0;
  const a = blankArrangement(id),
    saver = new EditorSaver(
      id,
      { revision: 1, arrangement: a },
      {
        put: async (v) => (persisted = v),
        clear: async () => (persisted = undefined),
      },
      (v) => (status = v),
      () => {},
      async () => {
        calls++;
        return Response.json({ revision: 2 });
      },
    );
  saver.ready = () => false;
  saver.change({ ...a, tempo: 140 });
  await assert.rejects(saver.flush(), /still uploading/);
  assert.equal(calls, 0);
  assert.equal(status, "Saving…");
  assert.equal(persisted.arrangement.tempo, 140);
  saver.ready = () => true;
  await saver.flush();
  assert.equal(calls, 1);
  assert.equal(status, "Saved");
  saver.close();
});
