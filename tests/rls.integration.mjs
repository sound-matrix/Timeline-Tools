import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("database RLS integration suite", () => {
  assert.ok(
    process.env.DATABASE_URL,
    "Set DATABASE_URL to a local/test Supabase PostgreSQL URL",
  );
  const run = spawnSync(
    "psql",
    [
      process.env.DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "supabase/tests/rls.sql",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.error?.message || run.stderr || run.stdout);
  assert.match(run.stdout, /RLS tests passed/);
});
