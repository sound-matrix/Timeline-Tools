-- Forward-only Audio Studio. Keep grants, RLS, billing and worker RPCs unchanged.
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check
 check(type in ('clean','master','subtitles','studio'));

-- A single owner-prefixed ZIP holds the complete project, including script.
-- Plan limits apply to the complete archive, not separately to every stem.
create or replace function private.upload_allowed(object_name text, object_metadata jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
 and split_part(object_name,'/',1)=auth.uid()::text
 and object_name ~* '^[0-9a-f-]+/[0-9a-f-]+\.(wav|mp3|m4a|flac|aac|ogg|mp4|mov|mkv|webm|zip)$'
 and exists(select 1 from public.profiles p join public.plans pl on pl.id=p.plan_id
 where p.id=auth.uid() and not p.suspended and pl.active
 and (object_metadata->>'size' is null or ((object_metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576)));
$$;

-- API checks are repeated here because clients can insert through PostgREST.
alter table public.jobs add constraint studio_input_zip
 check(type <> 'studio' or input_path ~ '^[0-9a-f-]+/[0-9a-f-]+\.zip$');
