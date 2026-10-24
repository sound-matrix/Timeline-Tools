import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const a = "a1111111-1111-4111-8111-111111111111";
const b = "b2222222-2222-4222-8222-222222222222";
const stub = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text,metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
grant usage on schema auth,storage,public to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
grant all on storage.objects to authenticated,service_role;
alter default privileges in schema public grant all on tables to service_role;
`;
async function database() {
  const db = new PGlite();
  await db.exec(stub);
  for (const f of readdirSync("supabase/migrations").sort())
    await db.exec(readFileSync("supabase/migrations/" + f, "utf8"));
  return db;
}
async function rpc(db, name, args) {
  return (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")})`,
      args,
    )
  ).rows;
}
async function queue(db, user = a, kind = "clean") {
  await db.exec(
    `reset role; select set_config('request.jwt.claim.sub','${user}',false);`,
  );
  const path = `${user}/${crypto.randomUUID()}.${["studio", "podcast"].includes(kind) ? "zip" : "wav"}`;
  await db.query(
    "insert into storage.objects(bucket_id,name,metadata) values('uploads',$1,'{\"size\":1024}')",
    [path],
  );
  await db.exec("set role authenticated");
  const row = (
    await db.query(
      "insert into public.jobs(file_name,input_path,type,settings) values('test.wav',$1,$2,'{}') returning id",
      [path, kind],
    )
  ).rows[0];
  await db.exec("reset role;set role service_role;");
  return row.id;
}
async function output(db, id, user = a) {
  const path = `${user}/${id}/clean.wav`;
  await db.query(
    "insert into storage.objects(bucket_id,name,metadata) values('outputs',$1,'{\"size\":20}')",
    [path],
  );
  return JSON.stringify([path]);
}
test("worker SQL: RLS, state transitions, atomic success charging, ownership, timeout and failure", async () => {
  const db = await database();
  try {
    await db.exec(readFileSync("supabase/tests/rls.sql", "utf8"));
    await db.exec(
      `insert into auth.users(id,email,raw_user_meta_data) values('${a}','a@example.invalid','{}'),('${b}','b@example.invalid','{}');`,
    );
    const id = await queue(db);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role;set role ${role}`);
      for (const [name, args] of [
        ["worker_claim", ["attacker"]],
        ["worker_prepare", [id, "attacker", 1]],
        ["worker_complete", [id, "attacker", "[]"]],
        ["worker_fail", [id, "attacker", "x"]],
      ])
        await assert.rejects(rpc(db, name, args), /permission denied/);
    }
    await db.exec("reset role;set role authenticated");
    for (const column of [
      "status='done'",
      "output_paths='[]'",
      "duration_sec=1",
      "error='x'",
      "minutes_charged=1",
      "worker_id='x'",
      "started_at=now()",
      "finished_at=now()",
    ])
      await assert.rejects(
        db.exec("update public.jobs set " + column),
        /permission denied/,
      );
    await db.exec("reset role;set role service_role");
    assert.equal((await rpc(db, "worker_claim", ["worker-a"]))[0].id, id);
    assert.equal((await rpc(db, "worker_claim", ["worker-b"])).length, 0);
    assert.equal(
      (await rpc(db, "worker_prepare", [id, "wrong", 61]))[0].worker_prepare,
      false,
    );
    assert.equal(
      (await rpc(db, "worker_prepare", [id, "worker-a", 61]))[0].worker_prepare,
      true,
    );
    const wrongPath = await output(db, id, b);
    await assert.rejects(
      rpc(db, "worker_complete", [id, "worker-a", wrongPath]),
      /Invalid output ownership/,
    );
    const paths = await output(db, id);
    assert.equal(
      (await rpc(db, "worker_complete", [id, "worker-a", paths]))[0]
        .worker_complete,
      true,
    );
    assert.equal(
      (await rpc(db, "worker_complete", [id, "worker-a", paths]))[0]
        .worker_complete,
      false,
    );
    assert.equal(
      (await rpc(db, "worker_fail", [id, "worker-a", "x"]))[0].worker_fail,
      false,
    );
    let job = (await db.query("select * from public.jobs where id=$1", [id]))
      .rows[0];
    assert.equal(job.status, "done");
    assert.equal(Number(job.minutes_charged), 2);
    assert.equal(job.error, null);
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_balance from public.profiles where id=$1",
            [a],
          )
        ).rows[0].minutes_balance,
      ),
      28,
    );
    const failed = await queue(db);
    await rpc(db, "worker_claim", ["failure"]);
    await rpc(db, "worker_prepare", [failed, "failure", 0.2]);
    await rpc(db, "worker_fail", [
      failed,
      "failure",
      "secret-text-must-not-be-stored",
    ]);
    assert.equal(
      (await db.query("select error from public.jobs where id=$1", [failed]))
        .rows[0].error,
      "Processing failed. Please try again.",
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_balance from public.profiles where id=$1",
            [a],
          )
        ).rows[0].minutes_balance,
      ),
      28,
    );
    const noFunds = await queue(db);
    await rpc(db, "worker_claim", ["cost"]);
    assert.equal(
      (await rpc(db, "worker_prepare", [noFunds, "cost", 1800]))[0]
        .worker_prepare,
      false,
    );
    // Two jobs pass preflight against the same one-minute balance; only one can commit.
    const x = await queue(db),
      y = await queue(db);
    await db.query("update public.profiles set minutes_balance=1 where id=$1", [
      a,
    ]);
    await rpc(db, "worker_claim", ["x"]);
    await rpc(db, "worker_claim", ["y"]);
    await rpc(db, "worker_prepare", [x, "x", 60]);
    await rpc(db, "worker_prepare", [y, "y", 60]);
    assert.equal(
      (await rpc(db, "worker_complete", [x, "x", await output(db, x)]))[0]
        .worker_complete,
      true,
    );
    assert.equal(
      (await rpc(db, "worker_complete", [y, "y", await output(db, y)]))[0]
        .worker_complete,
      false,
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_balance from public.profiles where id=$1",
            [a],
          )
        ).rows[0].minutes_balance,
      ),
      0,
    );
    const zero = await queue(db);
    assert.equal((await rpc(db, "worker_claim", ["zero"])).length, 0);
    assert.equal(
      (await db.query("select error from public.jobs where id=$1", [zero]))
        .rows[0].error,
      "Insufficient minutes",
    );
    await db.query(
      "update public.profiles set minutes_balance=10 where id=$1",
      [a],
    );
    const stale = await queue(db);
    await rpc(db, "worker_claim", ["stale"]);
    await db.query(
      "update public.jobs set started_at=now()-interval '3 hours' where id=$1",
      [stale],
    );
    await rpc(db, "worker_claim", ["sweep"]);
    assert.equal(
      (await db.query("select status from public.jobs where id=$1", [stale]))
        .rows[0].status,
      "failed",
    );
    assert.equal(
      (await rpc(db, "worker_complete", [stale, "stale", "[]"]))[0]
        .worker_complete,
      false,
    );
    // Existing media_read policy permits owner output access and denies everyone else.
    await db.exec(
      `reset role;select set_config('request.jwt.claim.sub','${a}',false);set role authenticated`,
    );
    assert.ok(
      (
        await db.query(
          "select * from storage.objects where bucket_id='outputs'",
        )
      ).rows.every((r) => r.name.startsWith(a + "/")),
    );
    await db.exec(
      `reset role;select set_config('request.jwt.claim.sub','${b}',false);set role authenticated`,
    );
    assert.equal(
      (await db.query("select * from public.jobs where id=$1", [id])).rows
        .length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("studio migration: ZIP ownership, compact settings and normal charging lifecycle", async () => {
  const db = await database();
  try {
    await db.exec(
      `insert into auth.users(id,email,raw_user_meta_data) values('${a}','a@example.invalid','{}'),('${b}','b@example.invalid','{}');`,
    );
    const id = await queue(db, a, "studio");
    await db.exec(
      `reset role; select set_config('request.jwt.claim.sub','${b}',false); set role authenticated`,
    );
    assert.equal(
      (await db.query("select * from public.jobs where id=$1", [id])).rows
        .length,
      0,
    );
    assert.equal(
      (
        await db.query("select private.upload_allowed($1,null) as ok", [
          a + "/11111111-1111-4111-8111-111111111111.zip",
        ])
      ).rows[0].ok,
      false,
    );
    await db.exec(
      `reset role; select set_config('request.jwt.claim.sub','${a}',false); set role authenticated`,
    );
    assert.equal(
      (
        await db.query("select private.upload_allowed($1,null) as ok", [
          a + "/11111111-1111-4111-8111-111111111111.zip",
        ])
      ).rows[0].ok,
      true,
    );
    assert.equal(
      (
        await db.query("select private.upload_allowed($1,null) as ok", [
          a + "/../input.zip",
        ])
      ).rows[0].ok,
      false,
    );
    await assert.rejects(
      db.query(
        "insert into public.jobs(file_name,input_path,type,settings) values('foreign',$1,'studio','{}')",
        [b + "/11111111-1111-4111-8111-111111111111.zip"],
      ),
      /Upload missing/,
    );
    await db.exec("reset role; set role service_role");
    assert.equal((await rpc(db, "worker_claim", ["studio-worker"]))[0].id, id);
    assert.equal(
      (await rpc(db, "worker_prepare", [id, "studio-worker", 61]))[0]
        .worker_prepare,
      true,
    );
    assert.equal(
      (
        await rpc(db, "worker_complete", [
          id,
          "studio-worker",
          await output(db, id),
        ])
      )[0].worker_complete,
      true,
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_charged from public.jobs where id=$1",
            [id],
          )
        ).rows[0].minutes_charged,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_balance from public.profiles where id=$1",
            [a],
          )
        ).rows[0].minutes_balance,
      ),
      28,
    );
  } finally {
    await db.close();
  }
});

test("DAW revision locks, ownership, immutable sources and first-export billing", async () => {
  const db = await database();
  try {
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,'a@test','{}'),($2,'b@test','{}')",
      [a, b],
    );
    const parent = await queue(db, a, "studio");
    await rpc(db, "worker_claim", ["parent-worker"]);
    await rpc(db, "worker_prepare", [parent, "parent-worker", 60]);
    const arrangement = {
      version: 1,
      job_id: parent,
      clips: [{ id: "c0", duration: 121 }],
      lines: [{ index: 0, text: "hello" }],
      duration: 121,
    };
    await db.query(
      "insert into public.studio_arrangements(job_id,user_id,arrangement_path,arrangement) values($1,$2,$3,$4)",
      [
        parent,
        a,
        `${a}/${parent}/arrangement-r1.json`,
        JSON.stringify(arrangement),
      ],
    );
    await rpc(db, "worker_complete", [
      parent,
      "parent-worker",
      await output(db, parent),
    ]);
    await db.exec(
      `reset role; select set_config('request.jwt.claim.sub','${a}',false);set role authenticated;`,
    );
    assert.equal(
      (
        await rpc(db, "save_arrangement", [
          parent,
          1,
          JSON.stringify(arrangement),
        ])
      )[0].save_arrangement,
      2,
    );
    await assert.rejects(
      rpc(db, "save_arrangement", [parent, 1, JSON.stringify(arrangement)]),
      /Revision conflict/,
    );
    await assert.rejects(
      rpc(db, "save_arrangement", [
        parent,
        2,
        JSON.stringify({ ...arrangement, clips: [] }),
      ]),
      /Invalid arrangement/,
    );
    await db.exec(
      `reset role; select set_config('request.jwt.claim.sub','${b}',false);set role authenticated;`,
    );
    assert.equal(
      (await db.query("select * from public.studio_arrangements")).rows.length,
      0,
    );
    await assert.rejects(
      rpc(db, "save_arrangement", [parent, 2, JSON.stringify(arrangement)]),
      /unavailable/,
    );
    await assert.rejects(
      db.query("update public.studio_arrangements set exports_count=0"),
      /permission denied/,
    );
    await db.exec(
      `reset role; select set_config('request.jwt.claim.sub','${a}',false);set role authenticated;`,
    );
    async function exportJob(cost) {
      return (
        await db.query(
          "insert into public.jobs(file_name,input_path,type,parent_job_id,confirmed_export_minutes,settings) values('export','placeholder','studio_export',$1,$2,'{\"revision\":2}') returning id",
          [parent, cost],
        )
      ).rows[0].id;
    }
    const first = await exportJob(0);
    await assert.rejects(exportJob(0), /confirm again/);
    const second = await exportJob(3);
    await db.exec("reset role;set role service_role;");
    await rpc(db, "worker_claim", ["export-1"]);
    await rpc(db, "worker_prepare", [first, "export-1", 121]);
    await rpc(db, "worker_claim", ["export-2"]);
    await rpc(db, "worker_prepare", [second, "export-2", 121]);
    const free = (
      await db.query(
        "select id,export_free from public.jobs where parent_job_id=$1 order by created_at,id",
        [parent],
      )
    ).rows;
    assert.equal(free.filter((r) => r.export_free).length, 1);
    await rpc(db, "worker_complete", [
      first,
      "export-1",
      await output(db, first),
    ]);
    await rpc(db, "worker_complete", [
      second,
      "export-2",
      await output(db, second),
    ]);
    const costs = (
      await db.query(
        "select minutes_charged from public.jobs where parent_job_id=$1 order by minutes_charged",
        [parent],
      )
    ).rows.map((r) => Number(r.minutes_charged));
    assert.deepEqual(costs, [0, 3]);
    assert.equal(
      (
        await db.query(
          "select exports_count from public.studio_arrangements where job_id=$1",
          [parent],
        )
      ).rows[0].exports_count,
      2,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.studio_arrangement_versions where job_id=$1",
          [parent],
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await db.close();
  }
});

test("Podcast migration: idempotent, owner RLS, revision snapshots, included export and exact output billing", async () => {
  const db = await database();
  try {
    const migration = readdirSync("supabase/migrations").find((f) =>
      f.endsWith("_podcast.sql"),
    );
    await db.exec(readFileSync("supabase/migrations/" + migration, "utf8"));
    await db.exec(
      `insert into auth.users(id,email,raw_user_meta_data) values('${a}','pod-a@example.invalid','{}'),('${b}','pod-b@example.invalid','{}');`,
    );
    const id = await queue(db, a, "podcast");
    const worker = "pod-worker";
    await rpc(db, "worker_claim", [worker]);
    assert.equal(
      (await rpc(db, "worker_prepare", [id, worker, 120]))[0].worker_prepare,
      true,
    );
    const source = `${a}/${id}/podcast-source.wav`;
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values('outputs',$1,'{\"size\":100}')",
      [source],
    );
    const t = {
      speakers: [{ id: "s0", name: "Speaker 1" }],
      words: [{ w: "Hello", start: 1, end: 2, speaker: "s0", conf: 0.9 }],
      segments: [],
      method: "synthetic",
    };
    await db.query(
      "insert into public.podcast_projects(job_id,user_id,duration,source_path,peaks_path) values($1,$2,120,$3,$3)",
      [id, a, source],
    );
    await db.query(
      "insert into public.podcast_transcripts(project_id,user_id,transcript) values($1,$2,$3)",
      [id, a, JSON.stringify(t)],
    );
    await db.query(
      "insert into public.podcast_edits(project_id,user_id) values($1,$2)",
      [id, a],
    );
    assert.equal(
      (
        await rpc(db, "worker_complete", [id, worker, JSON.stringify([source])])
      )[0].worker_complete,
      true,
    );
    await db.exec(
      `reset role;update public.profiles set minutes_balance=10 where id='${a}';set role authenticated;select set_config('request.jwt.claim.sub','${b}',false);`,
    );
    for (const table of [
      "podcast_projects",
      "podcast_transcripts",
      "podcast_edits",
    ])
      assert.equal(
        (await db.query(`select * from public.${table}`)).rows.length,
        0,
      );
    await assert.rejects(
      rpc(db, "save_podcast_edits", [id, 1, "{}"]),
      /Unavailable|permission/,
    );
    await db.exec(`select set_config('request.jwt.claim.sub','${a}',false);`);
    const edits = {
      operations: [
        { op: "delete", start: 10, end: 71 },
        { op: "insert", at: 120, duration: 1 },
      ],
      corrections: { 0: "Welcome" },
      speaker_names: { s0: "Host" },
    };
    assert.equal(
      (await rpc(db, "save_podcast_edits", [id, 1, JSON.stringify(edits)]))[0]
        .save_podcast_edits,
      2,
    );
    await assert.rejects(
      rpc(db, "save_podcast_edits", [id, 1, JSON.stringify(edits)]),
      /Revision conflict/,
    );
    await assert.rejects(
      db.query("update public.podcast_edits set edits=$1 where project_id=$2", [
        JSON.stringify(edits),
        id,
      ]),
      /permission denied/,
    );
    const exportJob = async (cost) =>
      (
        await db.query(
          "insert into public.jobs(file_name,input_path,type,parent_job_id,confirmed_export_minutes,settings) values('Podcast export','placeholder','podcast_export',$1,$2,'{\"revision\":2}') returning id,arrangement_snapshot",
          [id, cost],
        )
      ).rows[0];
    const first = await exportJob(0);
    assert.deepEqual(first.arrangement_snapshot.edits, edits);
    await assert.rejects(exportJob(0), /price changed/i);
    await db.exec("reset role;set role service_role;");
    await rpc(db, "worker_claim", ["free-worker"]);
    assert.equal(
      (await rpc(db, "worker_prepare", [first.id, "free-worker", 60]))[0]
        .worker_prepare,
      true,
    );
    assert.equal(
      (
        await rpc(db, "worker_complete", [
          first.id,
          "free-worker",
          await output(db, first.id),
        ])
      )[0].worker_complete,
      true,
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_balance from public.profiles where id=$1",
            [a],
          )
        ).rows[0].minutes_balance,
      ),
      10,
    );
    await db.exec("reset role;set role authenticated;");
    const second = await exportJob(1);
    await db.exec("reset role;set role service_role;");
    await rpc(db, "worker_claim", ["paid-worker"]);
    await rpc(db, "worker_prepare", [second.id, "paid-worker", 60]);
    await rpc(db, "worker_complete", [
      second.id,
      "paid-worker",
      await output(db, second.id),
    ]);
    assert.equal(
      Number(
        (
          await db.query(
            "select minutes_balance from public.profiles where id=$1",
            [a],
          )
        ).rows[0].minutes_balance,
      ),
      9,
    );
    assert.equal(
      (
        await db.query(
          "select exports_count from public.podcast_projects where job_id=$1",
          [id],
        )
      ).rows[0].exports_count,
      2,
    );
  } finally {
    await db.close();
  }
});
