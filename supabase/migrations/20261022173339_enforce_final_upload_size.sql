-- Storage 1.80 finalizes uploads as its database owner, bypassing RLS.
-- Enforce plan limits on the final server-measured metadata as well as RLS probes.
create function private.enforce_upload_limit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.bucket_id='uploads' and new.metadata->>'size' is not null then
  if not exists(select 1 from public.profiles p join public.plans pl on pl.id=p.plan_id
   where p.id::text=split_part(new.name,'/',1) and not p.suspended and pl.active
   and (new.metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576)
  then raise exception 'Upload exceeds plan limit or account unavailable' using errcode='42501'; end if;
 end if;
 return new;
end;$$;
revoke all on function private.enforce_upload_limit() from public;
create trigger timeline_upload_limit before insert or update of metadata,name,bucket_id on storage.objects
 for each row execute function private.enforce_upload_limit();
