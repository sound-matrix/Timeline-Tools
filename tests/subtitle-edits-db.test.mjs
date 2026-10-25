import test from "node:test";
import assert from "node:assert/strict";
import { database } from "./fixtures/database.mjs";
const owner = "a1111111-1111-4111-8111-111111111111",
  other = "b2222222-2222-4222-8222-222222222222";
const as = async (db, id) =>
  db.exec(
    `reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated`,
  );
for (const type of ["subtitles", "studio"])
  test(`${type} edits RLS: owner save/reload/revert, foreign read/write/delete and reassignment denied`, async () => {
    const db = await database();
    try {
      await db.exec(
        `insert into auth.users(id,email,raw_user_meta_data) values('${owner}','sub-a@test','{}'),('${other}','sub-b@test','{}')`,
      );
      const ids = [];
      for (const user of [owner, other]) {
        const path = `${user}/${crypto.randomUUID()}.${type === "studio" ? "zip" : "wav"}`;
        await db.exec(
          `reset role;select set_config('request.jwt.claim.sub','${user}',false)`,
        );
        await db.query(
          "insert into storage.objects(bucket_id,name,metadata) values('uploads',$1,'{\"size\":1024}')",
          [path],
        );
        await as(db, user);
        const id = (
          await db.query(
            "insert into jobs(file_name,input_path,type,settings) values('sub.wav',$1,$2,'{}') returning id",
            [path, type],
          )
        ).rows[0].id;
        await db.exec("reset role");
        await db.query("update jobs set status='done' where id=$1", [id]);
        ids.push(id);
      }
      await as(db, owner);
      await db.query(
        "insert into subtitle_edits(job_id,user_id,cues) values($1,$2,$3)",
        [
          ids[0],
          owner,
          JSON.stringify([{ start: 0, end: 1, text: "Original" }]),
        ],
      );
      await db.query("update subtitle_edits set cues=$1 where job_id=$2", [
        JSON.stringify([{ start: 0, end: 1, text: "Corrected" }]),
        ids[0],
      ]);
      assert.equal(
        (await db.query("select cues from subtitle_edits")).rows[0].cues[0]
          .text,
        "Corrected",
      );
      await assert.rejects(
        db.query("update subtitle_edits set user_id=$1", [other]),
        /row-level security/,
      );
      await assert.rejects(
        db.query("update subtitle_edits set job_id=$1", [ids[1]]),
        /row-level security/,
      );
      await assert.rejects(
        db.query(
          "insert into subtitle_edits(job_id,user_id,cues) values($1,$2,'[]')",
          [ids[1], owner],
        ),
        /row-level security/,
      );
      await as(db, other);
      assert.equal(
        (await db.query("select * from subtitle_edits")).rows.length,
        0,
      );
      assert.equal(
        (await db.query("update subtitle_edits set cues='[]' returning job_id"))
          .rows.length,
        0,
      );
      assert.equal(
        (await db.query("delete from subtitle_edits returning job_id")).rows
          .length,
        0,
      );
      await db.exec("reset role;set role anon");
      await assert.rejects(
        db.query("select * from subtitle_edits"),
        /permission denied/,
      );
      await as(db, owner);
      assert.equal(
        (await db.query("delete from subtitle_edits returning job_id")).rows
          .length,
        1,
      );
    } finally {
      await db.close();
    }
  });
