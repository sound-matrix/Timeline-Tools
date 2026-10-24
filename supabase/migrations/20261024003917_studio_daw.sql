-- Forward-only; no live migration or Modal deploy is performed by this PR.
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check(type in ('clean','master','subtitles','studio','studio_export'));
alter table public.jobs add column parent_job_id uuid references public.jobs(id) on delete cascade;
alter table public.jobs add column error_code text;
alter table public.jobs add column error_detail jsonb check(error_detail is null or octet_length(error_detail::text)<=8192);
alter table public.jobs add column peaks_paths jsonb not null default '[]'::jsonb check(jsonb_typeof(peaks_paths)='array');
alter table public.jobs add column arrangement_snapshot jsonb;
alter table public.jobs add column confirmed_export_minutes integer check(confirmed_export_minutes>=0);
alter table public.jobs add column export_free boolean not null default false;
alter table public.jobs add constraint studio_export_parent check(type<>'studio_export' or parent_job_id is not null);
create index jobs_parent_export on public.jobs(parent_job_id) where type='studio_export';
grant insert(parent_job_id,confirmed_export_minutes) on public.jobs to authenticated;

create table public.studio_arrangements (
 job_id uuid primary key references public.jobs(id) on delete cascade,
 user_id uuid not null references public.profiles(id),
 revision integer not null default 1 check(revision>=1),
 arrangement_path text not null,
 arrangement jsonb not null check(octet_length(arrangement::text)<=524288),
 exports_count integer not null default 0 check(exports_count>=0),
 updated_at timestamptz not null default now()
);
alter table public.studio_arrangements enable row level security;
revoke all on public.studio_arrangements from anon,authenticated;
grant select on public.studio_arrangements to authenticated;
grant all on public.studio_arrangements to service_role;
create policy arrangements_owner_select on public.studio_arrangements for select to authenticated using(user_id=(select auth.uid()) and (select private.is_active()));

create function public.save_arrangement(p_job uuid,p_revision integer,p_arrangement jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare a public.studio_arrangements;
begin
 select * into a from public.studio_arrangements where job_id=p_job and user_id=auth.uid() for update;
 if not found or not private.is_active() then raise exception 'Arrangement unavailable' using errcode='42501'; end if;
 if a.revision<>p_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
 if octet_length(p_arrangement::text)>524288 or jsonb_typeof(p_arrangement)<>'object'
 or p_arrangement->'version' is distinct from '1'::jsonb
 or p_arrangement->'clips' is distinct from a.arrangement->'clips'
 or p_arrangement->'lines' is distinct from a.arrangement->'lines'
 or p_arrangement->'job_id' is distinct from a.arrangement->'job_id'
 then raise exception 'Invalid arrangement'; end if;
 update public.studio_arrangements set arrangement=p_arrangement,revision=revision+1,
updated_at=now() where job_id=p_job;
 return a.revision+1;
end;$$;
revoke all on function public.save_arrangement(uuid,integer,jsonb) from public,anon;
grant execute on function public.save_arrangement(uuid,integer,jsonb) to authenticated;

create or replace function private.validate_job() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.studio_arrangements; j public.jobs;
begin
 if auth.uid() is null or new.user_id<>auth.uid() or not private.is_active() then raise exception 'Invalid job owner'; end if;
 if new.type='studio_export' then
  select * into j from public.jobs where id=new.parent_job_id and user_id=auth.uid() and type='studio' and status='done';
  select * into a from public.studio_arrangements where job_id=j.id and user_id=auth.uid() for update;
  if j.id is null or a.job_id is null or a.revision<>(new.settings->>'revision')::integer then raise exception 'Revision conflict' using errcode='40001'; end if;
  new.input_path:=new.user_id::text||'/'||j.id::text||'/export-'||new.id::text||'.json';
  new.export_free := not exists(select 1 from public.jobs x where x.parent_job_id=j.id and x.export_free and x.status in ('queued','processing','done'));
  if new.confirmed_export_minutes is distinct from (case when new.export_free then 0 else ceil((a.arrangement->>'duration')::numeric/60)::integer end) then raise exception 'Export price changed; confirm again' using errcode='40001'; end if;
  new.arrangement_snapshot:=a.arrangement;
  return new;
 end if;
 if new.parent_job_id is not null then raise exception 'Invalid parent'; end if;
 if not exists(select 1 from storage.objects o join public.profiles p on p.id=new.user_id join public.plans pl on pl.id=p.plan_id
 where o.bucket_id='uploads' and o.name=new.input_path and split_part(o.name,'/',1)=new.user_id::text
 and (o.metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576 and pl.active)
 then raise exception 'Upload missing or exceeds plan limit'; end if;
 return new;
end;$$;

create function private.export_is_free(job uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select export_free from public.jobs where id=job and type='studio_export'),false);
$$;
revoke all on function private.export_is_free(uuid) from public,anon,authenticated;
grant execute on function private.export_is_free(uuid) to service_role;

create or replace function private.worker_claim(p_worker_id text) returns setof public.jobs
language plpgsql security definer set search_path='' as $$
declare j public.jobs; available numeric; blocked boolean;
begin
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 then raise exception 'Invalid worker'; end if;
 -- Worker hard timeout is 60 minutes. Fail abandoned claims after 2h, never requeue
 -- them automatically: a late worker cannot finalize or charge a failed job.
 update public.jobs set status='failed',error='Processing timed out. Please submit again.',finished_at=now()
 where status='processing' and started_at < now()-interval '2 hours';
 select * into j from public.jobs where status='queued' order by created_at,id for update skip locked limit 1;
 if not found then return; end if;
 select p.minutes_balance, (p.suspended or not pl.active) into available,blocked
 from public.profiles p join public.plans pl on pl.id=p.plan_id where p.id=j.user_id for update of p;
 if blocked or available is null or (available<1 and (j.type<>'studio_export' or exists(select 1 from public.jobs x where x.parent_job_id=j.parent_job_id and x.export_free and x.status in ('processing','done')))) then
  update public.jobs set status='failed',error=case when blocked then 'Account or plan unavailable' else 'Insufficient minutes' end,finished_at=now() where id=j.id;
  return;
 end if;
 return query update public.jobs set status='processing',started_at=now(),worker_id=p_worker_id,error=null where id=j.id returning *;
end;$$;
create or replace function private.worker_prepare(p_job_id uuid,p_worker_id text,p_duration numeric) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.jobs; available numeric; blocked boolean; cost numeric;
begin
 select * into j from public.jobs where id=p_job_id and status='processing' and worker_id=p_worker_id for update;
 if not found then return false; end if;
 if p_duration is null or p_duration<=0 or p_duration::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid duration'; end if;
 if j.type='studio_export' then
  perform 1 from public.studio_arrangements where job_id=j.parent_job_id for update;
  update public.jobs set export_free=not exists(select 1 from public.jobs x where x.parent_job_id=j.parent_job_id and x.id<>j.id and x.export_free and x.status in ('queued','processing','done')) where id=j.id;
 end if;
 cost:=case when private.export_is_free(j.id) then 0 else ceil(p_duration/60.0) end;
 select p.minutes_balance,(p.suspended or not pl.active) into available,blocked
 from public.profiles p join public.plans pl on pl.id=p.plan_id where p.id=j.user_id for update of p;
 if blocked or available is null or available<cost then
  update public.jobs set status='failed',duration_sec=p_duration,error=case when blocked then 'Account or plan unavailable' else 'Insufficient minutes' end,finished_at=now() where id=j.id;
  return false;
 end if;
 update public.jobs set duration_sec=p_duration where id=j.id;
 return true;
end;$$;
create or replace function private.worker_complete(p_job_id uuid,p_worker_id text,p_outputs jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.jobs; cost numeric;
begin
 select * into j from public.jobs where id=p_job_id and status='processing' and worker_id=p_worker_id for update;
 if not found then return false; end if;
 if j.duration_sec is null or j.duration_sec<=0 then raise exception 'Duration required'; end if;
 if p_outputs is null or jsonb_typeof(p_outputs)!='array' then raise exception 'Invalid outputs'; end if;
 if jsonb_array_length(p_outputs) not between 1 and 410 then raise exception 'Invalid outputs'; end if;
 if exists(select 1 from jsonb_array_elements(p_outputs) v where jsonb_typeof(v)!='string')
 or exists(select 1 from jsonb_array_elements_text(p_outputs) v where
  v not like j.user_id::text||'/'||j.id::text||'/%' or v ~ '(^|/)\.\.(/|$)' or
  not exists(select 1 from storage.objects o where o.bucket_id='outputs' and o.name=v))
 then raise exception 'Invalid output ownership'; end if;
 if j.type='studio_export' then
  perform 1 from public.studio_arrangements where job_id=j.parent_job_id for update;
  if (select exports_count from public.studio_arrangements where job_id=j.parent_job_id)=0 then
   update public.jobs set export_free=true where id=j.id;
  elsif j.confirmed_export_minutes=0 then
   update public.jobs set status='failed',error='The included export was used elsewhere. Confirm the re-export cost.',finished_at=now() where id=j.id;
   return false;
  else
   update public.jobs set export_free=false where id=j.id;
  end if;
 end if;
 cost:=case when private.export_is_free(j.id) then 0 else ceil(j.duration_sec/60.0) end;
 update public.profiles p set minutes_balance=p.minutes_balance-cost
 where p.id=j.user_id and not p.suspended and p.minutes_balance>=cost
 and exists(select 1 from public.plans pl where pl.id=p.plan_id and pl.active);
 if not found then
  update public.jobs set status='failed',error=case when exists(select 1 from public.profiles p join public.plans pl on pl.id=p.plan_id where p.id=j.user_id and not p.suspended and pl.active) then 'Insufficient minutes' else 'Account or plan unavailable' end,finished_at=now() where id=j.id;
  return false;
 end if;
 if j.type='studio_export' then update public.studio_arrangements set exports_count=exports_count+1 where job_id=j.parent_job_id; end if;
 update public.jobs set status='done',output_paths=p_outputs,minutes_charged=cost,error=null,finished_at=now() where id=j.id;
 return true;
end;$$;

create or replace function private.worker_fail(p_job_id uuid,p_worker_id text,p_code text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update public.jobs set status='failed',finished_at=now(),error_code=coalesce(error_code,p_code),error=case p_code
 when 'language_mismatch' then 'The language of the clips and the script don''t match'
 when 'invalid_media' then 'Unable to read audio from this file'
 when 'invalid_settings' then 'Invalid processing settings'
 when 'storage' then 'File transfer failed. Please try again.'
 when 'timeout' then 'Processing timed out. Please submit again.'
 else 'Processing failed. Please try again.' end where id=p_job_id and status='processing' and worker_id=p_worker_id;
 return found;
end;$$;

create table public.studio_arrangement_versions (
 job_id uuid references public.studio_arrangements(job_id) on delete cascade,
 revision integer not null,
 user_id uuid not null references public.profiles(id),
 arrangement jsonb not null check(octet_length(arrangement::text)<=524288),
 primary key(job_id,revision)
);
alter table public.studio_arrangement_versions enable row level security;
revoke all on public.studio_arrangement_versions from anon,authenticated;
grant select on public.studio_arrangement_versions to authenticated;
grant all on public.studio_arrangement_versions to service_role;
create policy arrangement_versions_owner on public.studio_arrangement_versions for select to authenticated using(user_id=(select auth.uid()) and (select private.is_active()));
create function private.version_arrangement() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or new.revision<>old.revision then
  insert into public.studio_arrangement_versions(job_id,revision,user_id,arrangement) values(new.job_id,new.revision,new.user_id,new.arrangement);
 end if;
 return new;
end;$$;
revoke all on function private.version_arrangement() from public,anon,authenticated;
create trigger version_arrangement after insert or update on public.studio_arrangements for each row execute function private.version_arrangement();
