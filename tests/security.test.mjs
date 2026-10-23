import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
const sql = readFileSync(
  "supabase/migrations/" + readdirSync("supabase/migrations")[0],
  "utf8",
);
test("profile edits use column grants; privileged profile fields have no client grants", () => {
  assert.match(
    sql,
    /grant update\(display_name\) on public.profiles to authenticated/i,
  );
  assert.doesNotMatch(
    sql,
    /grant\s+(?:all|update)\s+on\s+public.profiles\s+to\s+authenticated/i,
  );
});
test("every application table enables RLS", () => {
  for (const table of [
    "profiles",
    "plans",
    "topup_packs",
    "coupons",
    "jobs",
    "audit_log",
  ])
    assert.ok(
      sql.includes(`alter table public.${table} enable row level security;`),
    );
});
test("job ownership and admin RPC authorization are database enforced", () => {
  assert.match(sql, /user_id=\(select auth.uid\(\)\)/);
  assert.match(sql, /if not private.is_admin\(\) then raise exception/);
  assert.match(sql, /create trigger audit_profiles/);
});
test("service role client has server-only boundary", () =>
  assert.match(
    readFileSync("lib/supabase/service.ts", "utf8"),
    /^import ['"]server-only['"]/,
  ));
