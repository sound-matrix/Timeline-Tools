-- Storage probes contain MIME/contentLength but no measured size. Final authorization
-- re-runs with server-measured size. Never use user_metadata for size limits.
create or replace function private.upload_allowed(object_name text, object_metadata jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
 and split_part(object_name,'/',1)=auth.uid()::text
 and object_name ~* '^[0-9a-f-]+/[0-9a-f-]+\.(wav|mp3|m4a|flac|aac|ogg|mp4|mov|mkv|webm)$'
 and exists(select 1 from public.profiles p join public.plans pl on pl.id=p.plan_id
 where p.id=auth.uid() and not p.suspended and pl.active
 and (object_metadata->>'size' is null or ((object_metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576)));
$$;
