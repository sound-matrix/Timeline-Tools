import {PGlite} from "@electric-sql/pglite";
import {readFileSync,readdirSync} from "node:fs";
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
export async function database() {
  const db = new PGlite();
  await db.exec(stub);
  for (const f of readdirSync("supabase/migrations").sort())
    await db.exec(readFileSync("supabase/migrations/" + f, "utf8"));
  return db;
}
export async function rpc(db, name, args) {
  return (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")})`,
      args,
    )
  ).rows;
}
