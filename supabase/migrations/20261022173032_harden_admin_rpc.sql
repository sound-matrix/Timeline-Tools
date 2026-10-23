-- Keep the privileged implementation outside the exposed API schema.
alter function public.admin_save(text,text,jsonb) set schema private;
create function public.admin_save(entity text, record_id text, payload jsonb) returns void
language sql security invoker set search_path='' as $$
 select private.admin_save(entity,record_id,payload);
$$;
revoke all on function public.admin_save(text,text,jsonb) from public,anon;
grant execute on function public.admin_save(text,text,jsonb) to authenticated;

-- Storage's initial permission probe uses {} (not always SQL NULL).
-- Actual finalized objects carry a server-measured size; job creation also requires it.
create or replace function private.upload_allowed(object_name text, object_metadata jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
 and split_part(object_name,'/',1)=auth.uid()::text
 and object_name ~* '^[0-9a-f-]+/[0-9a-f-]+\.(wav|mp3|m4a|flac|aac|ogg|mp4|mov|mkv|webm)$'
 and exists(select 1 from public.profiles p join public.plans pl on pl.id=p.plan_id
 where p.id=auth.uid() and not p.suspended and pl.active
 and (object_metadata is null or object_metadata='{}'::jsonb or ((object_metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576)));
$$;
