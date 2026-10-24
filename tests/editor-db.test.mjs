import test from "node:test";
import assert from "node:assert/strict";
import { database, rpc } from "./fixtures/database.mjs";
import { blankArrangement, importPlacement } from "../lib/editor/model.ts";
const owner = "a1111111-1111-4111-8111-111111111111",
  other = "b2222222-2222-4222-8222-222222222222";
const as = async (db, id) =>
  db.exec(
    `reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated`,
  );
const call = async (db, name, args) => (await rpc(db, name, args))[0][name];
async function seed(db) {
  await db.exec(
    `insert into auth.users(id,email,raw_user_meta_data) values('${owner}','editor-a@test','{}'),('${other}','editor-b@test','{}')`,
  );
  await as(db, owner);
}
test("Editor RLS: foreign users cannot read/save/register, source assets are validated, identical saves deduplicate, versions retain checkpoints", async () => {
  const db = await database();
  try {
    await seed(db);
    const id = await call(db, "create_editor_project", [
      "Blank",
      "blank",
      null,
    ]);
    let a = blankArrangement(id);
    await assert.rejects(
      db.query("update public.editor_projects set name=$1 where id=$2", [
        "attack",
        id,
      ]),
      /permission denied/,
    );
    const asset = crypto.randomUUID(),
      path = `editor/${owner}/${id}/${asset}.wav`,
      peaks = `editor/${owner}/${id}/${asset}.peaks`;
    await as(db, other);
    for (const table of [
      "editor_projects",
      "editor_assets",
      "editor_arrangement_versions",
    ])
      assert.equal(
        (await db.query("select * from public." + table)).rows.length,
        0,
      );
    await assert.rejects(
      call(db, "save_editor_arrangement", [id, 1, JSON.stringify(a)]),
      /unavailable/i,
    );
    await assert.rejects(
      call(db, "register_editor_asset", [
        id,
        asset,
        path,
        peaks,
        "test",
        "audio/wav",
        2,
        48000,
        2,
        4096,
      ]),
      /unavailable/i,
    );
    assert.equal(
      (await db.query("select private.upload_allowed($1,null) ok", [path]))
        .rows[0].ok,
      false,
    );
    await as(db, owner);
    assert.equal(
      (await db.query("select private.upload_allowed($1,null) ok", [path]))
        .rows[0].ok,
      true,
    );
    await db.exec("reset role");
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values('uploads',$1,'{\"size\":4096}'),('uploads',$2,'{\"size\":1024}')",
      [path, peaks],
    );
    await as(db, owner);
    await assert.rejects(
      call(db, "register_editor_asset", [
        id,
        asset,
        path.replace(owner, other),
        peaks,
        "test",
        "audio/wav",
        2,
        48000,
        2,
        4096,
      ]),
      /path/i,
    );
    assert.equal(
      await call(db, "register_editor_asset", [
        id,
        asset,
        path,
        peaks,
        "test",
        "audio/wav",
        2,
        48000,
        2,
        4096,
      ]),
      asset,
    );
    a = importPlacement(
      a,
      { id: asset, asset, name: "test.wav", duration: 2 },
      { time: 0 },
    );
    let revision = await call(db, "save_editor_arrangement", [
      id,
      1,
      JSON.stringify(a),
    ]);
    assert.equal(revision, 2);
    assert.equal(
      await call(db, "save_editor_arrangement", [
        id,
        revision,
        JSON.stringify(a),
      ]),
      revision,
    );
    await assert.rejects(
      call(db, "save_editor_arrangement", [id, 1, JSON.stringify(a)]),
      /Revision conflict/,
    );
    await assert.rejects(
      call(db, "save_editor_arrangement", [
        id,
        revision,
        JSON.stringify({
          ...a,
          clips: [{ ...a.clips[0], asset: crypto.randomUUID() }],
        }),
      ]),
      /ownership/i,
    );
    for (let n = 0; n < 80; n++) {
      a = { ...a, snap: !a.snap };
      revision = await call(db, "save_editor_arrangement", [
        id,
        revision,
        JSON.stringify(a),
      ]);
    }
    const count = (
      await db.query(
        "select count(*)::int n from public.editor_arrangement_versions where project_id=$1",
        [id],
      )
    ).rows[0].n;
    assert.ok(count >= 50 && count <= 74);
    await as(db, other);
    assert.equal(
      (await db.query("select * from public.editor_assets")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
test("Editor cloud export reserves one free export, quotes output length, and charges only successful output", async () => {
  const db = await database();
  try {
    await seed(db);
    const id = await call(db, "create_editor_project", [
      "Cloud",
      "blank",
      null,
    ]);
    async function queue(cost) {
      return (
        await db.query(
          'insert into public.jobs(type,editor_project_id,file_name,input_path,confirmed_export_minutes,settings) values(\'editor_export\',$1,\'Editor export\',\'placeholder\',$2,\'{"revision":1,"range":[0,60],"options":{"format":"wav","rate":48000,"depth":24,"bitrate":320,"normalize":false}}\') returning id',
          [id, cost],
        )
      ).rows[0].id;
    }
    const first = await queue(0);
    await assert.rejects(queue(0), /price changed/i);
    const second = await queue(1);
    await db.exec("reset role;set role service_role");
    await call(db, "worker_claim", ["editor-worker"]);
    await call(db, "worker_prepare", [first, "editor-worker", 60]);
    const output = `${owner}/${first}/editor-mix.wav`;
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values('outputs',$1,'{\"size\":2048}')",
      [output],
    );
    assert.equal(
      await call(db, "worker_complete", [
        first,
        "editor-worker",
        JSON.stringify([output]),
      ]),
      true,
    );
    assert.equal(
      (
        await db.query("select minutes_charged from public.jobs where id=$1", [
          first,
        ])
      ).rows[0].minutes_charged,
      "0.00",
    );
    await call(db, "worker_claim", ["paid-worker"]);
    await call(db, "worker_prepare", [second, "paid-worker", 60]);
    const paid = `${owner}/${second}/editor-mix.wav`;
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values('outputs',$1,'{\"size\":2048}')",
      [paid],
    );
    await call(db, "worker_complete", [
      second,
      "paid-worker",
      JSON.stringify([paid]),
    ]);
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_balance from public.profiles where id=$1",
            [owner],
          )
        ).rows[0].minutes_balance,
      ),
      29,
    );
    assert.equal(
      (
        await db.query(
          "select exports_count from public.editor_projects where id=$1",
          [id],
        )
      ).rows[0].exports_count,
      2,
    );
  } finally {
    await db.close();
  }
});
test("forked source exports share the included reservation and cannot create another free render", async () => {
  const db = await database();
  try {
    await seed(db);
    await db.exec("reset role");
    const source = crypto.randomUUID();
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values('uploads',$1,'{\"size\":4096}')",
      [`${owner}/${source}.zip`],
    );
    await db.query(
      "insert into public.jobs(id,user_id,type,file_name,input_path,status) values($1,$2,'studio','Studio source',$3,'done')",
      [source, owner, `${owner}/${source}.zip`],
    );
    const { readFileSync } = await import("node:fs");
    const original = JSON.parse(
      readFileSync("tests/fixtures/daw-arrangement.json", "utf8"),
    );
    original.job_id = source;
    await db.query(
      "insert into public.studio_arrangements(job_id,user_id,arrangement_path,arrangement) values($1,$2,'fixture',$3)",
      [source, owner, JSON.stringify(original)],
    );
    await as(db, owner);
    const one = await call(db, "create_editor_project", [
        "One",
        "studio",
        source,
      ]),
      two = await call(db, "create_editor_project", ["Two", "studio", source]);
    const queue = (project) =>
      db.query(
        "insert into public.jobs(type,editor_project_id,file_name,input_path,confirmed_export_minutes,settings) values('editor_export',$1,'Editor','pending',0,'{\"revision\":1,\"range\":[0,2]}') returning id",
        [project],
      );
    await queue(one);
    await assert.rejects(queue(two), /price changed/i);
    await as(db, other);
    await assert.rejects(
      call(db, "create_editor_project", ["Steal", "studio", source]),
      /unavailable/i,
    );
  } finally {
    await db.close();
  }
});
