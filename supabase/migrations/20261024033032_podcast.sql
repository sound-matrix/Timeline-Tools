-- Human applies in Supabase SQL Editor after approval. Idempotent; no live DDL.
alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check check(type in ('clean','master','subtitles','studio','studio_export','podcast','podcast_export'));
alter table public.jobs drop constraint if exists podcast_export_parent;
alter table public.jobs add constraint podcast_export_parent check(type<>'podcast_export' or parent_job_id is not null);
alter table public.jobs drop constraint if exists podcast_bundle_path;
alter table public.jobs add constraint podcast_bundle_path check(type<>'podcast' or input_path ~ '^[0-9a-f-]+/[0-9a-f-]+\.zip$');
create index if not exists jobs_podcast_exports on public.jobs(parent_job_id) where type='podcast_export';

create table if not exists public.podcast_projects (
 job_id uuid primary key references public.jobs(id) on delete cascade,
 user_id uuid not null references public.profiles(id),
 duration numeric not null check(duration>0 and duration<=14400),
 source_path text not null,
 peaks_path text not null,
 revision integer not null default 1 check(revision>0),
 exports_count integer not null default 0 check(exports_count>=0),
 unique(job_id,user_id)
);
create table if not exists public.podcast_media (
 project_id uuid not null,
 user_id uuid not null,
 media_index integer not null check(media_index between 0 and 199),
 name text not null check(length(name) between 1 and 255),
 offset_sec numeric not null check(offset_sec between 0 and 14400),
 duration numeric not null check(duration>0 and duration<=14400),
 proxy_path text,
 primary key(project_id,media_index),
 foreign key(project_id,user_id) references public.podcast_projects(job_id,user_id) on delete cascade
);
create table if not exists public.podcast_transcripts (
 project_id uuid primary key,
 user_id uuid not null,
 transcript jsonb not null check(jsonb_typeof(transcript)='object' and octet_length(transcript::text)<=16777216),
 foreign key(project_id,user_id) references public.podcast_projects(job_id,user_id) on delete cascade
);
create table if not exists public.podcast_edits (
 project_id uuid primary key,
 user_id uuid not null,
 edits jsonb not null default '{"operations":[],"corrections":{},"speaker_names":{}}',
 updated_at timestamptz not null default now(),
 check(jsonb_typeof(edits)='object' and octet_length(edits::text)<=4194304),
 foreign key(project_id,user_id) references public.podcast_projects(job_id,user_id) on delete cascade
);
alter table public.podcast_projects enable row level security;
alter table public.podcast_media enable row level security;
alter table public.podcast_transcripts enable row level security;
alter table public.podcast_edits enable row level security;
revoke all on public.podcast_projects,public.podcast_media,public.podcast_transcripts,public.podcast_edits from anon,authenticated;
grant select on public.podcast_projects,public.podcast_media,public.podcast_transcripts,public.podcast_edits to authenticated;
grant all on public.podcast_projects,public.podcast_media,public.podcast_transcripts,public.podcast_edits to service_role;
drop policy if exists podcast_owner on public.podcast_projects;
create policy podcast_owner on public.podcast_projects for select to authenticated using(user_id=(select auth.uid()) and (select private.is_active()) and exists(select 1 from public.jobs j where j.id=job_id and j.user_id=(select auth.uid()) and j.type='podcast' and j.status='done'));
drop policy if exists podcast_media_owner on public.podcast_media;
create policy podcast_media_owner on public.podcast_media for select to authenticated using(user_id=(select auth.uid()) and exists(select 1 from public.podcast_projects p where p.job_id=project_id));
drop policy if exists podcast_transcript_owner on public.podcast_transcripts;
create policy podcast_transcript_owner on public.podcast_transcripts for select to authenticated using(user_id=(select auth.uid()) and exists(select 1 from public.podcast_projects p where p.job_id=project_id));
drop policy if exists podcast_edits_owner on public.podcast_edits;
create policy podcast_edits_owner on public.podcast_edits for select to authenticated using(user_id=(select auth.uid()) and exists(select 1 from public.podcast_projects p where p.job_id=project_id));
-- Files use existing private uploads/outputs buckets and policies. Their existing
-- storage.foldername(name)[1]=auth.uid() rules and completed-job output membership
-- checks also cover Podcast ZIPs, WAVs, MP4 proxies and transcript JSON. No public bucket.

create or replace function private.podcast_duration(p_duration numeric,p_edits jsonb) returns numeric
language plpgsql immutable set search_path='' as $$
declare o jsonb; a numeric; b numeric; last_end numeric:=0; removed numeric:=0; added numeric:=0;
begin
 if p_duration is null or p_duration::text in ('NaN','Infinity','-Infinity') or p_duration<=0 or p_duration>14400
 or jsonb_typeof(p_edits) is distinct from 'object' or jsonb_typeof(p_edits->'operations') is distinct from 'array'
 or jsonb_typeof(p_edits->'corrections') is distinct from 'object' or jsonb_typeof(p_edits->'speaker_names') is distinct from 'object'
 or jsonb_array_length(p_edits->'operations')>2000 or octet_length(p_edits::text)>4194304 then raise exception 'Invalid edits';end if;
 for o in select value from jsonb_array_elements(p_edits->'operations') loop
  if o->>'op' not in ('delete','mute','bleep','insert') or o->>'op' is null then raise exception 'Invalid operation';end if;
  if o->>'op'='insert' then
   a:=(o->>'at')::numeric;b:=(o->>'duration')::numeric;
   if a is null or b is null or a::text in ('NaN','Infinity','-Infinity') or b::text in ('NaN','Infinity','-Infinity') or a<0 or a>p_duration or b<=0 or b>60 then raise exception 'Invalid insertion';end if;
   if not exists(select 1 from jsonb_array_elements(p_edits->'operations') d where d->>'op'='delete' and a>(d->>'start')::numeric and a<(d->>'end')::numeric) then added:=added+b;end if;
  else
   a:=(o->>'start')::numeric;b:=(o->>'end')::numeric;
   if a is null or b is null or a::text in ('NaN','Infinity','-Infinity') or b::text in ('NaN','Infinity','-Infinity') or a<0 or b<=a or b>p_duration then raise exception 'Invalid range';end if;
  end if;
 end loop;
 for o in select value from jsonb_array_elements(p_edits->'operations') where value->>'op'='delete' order by (value->>'start')::numeric loop
  a:=(o->>'start')::numeric;b:=(o->>'end')::numeric;
  removed:=removed+greatest(0,b-greatest(a,last_end));last_end:=greatest(last_end,b);
 end loop;
 a:=p_duration-removed+added;
 if a<=0 or a>14400 then raise exception 'Invalid output duration';end if;
 return a;
end;$$;
revoke all on function private.podcast_duration(numeric,jsonb) from public,anon,authenticated;
grant execute on function private.podcast_duration(numeric,jsonb) to service_role;

create or replace function public.save_podcast_edits(p_job uuid,p_revision integer,p_edits jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare p public.podcast_projects;
begin
 select * into p from public.podcast_projects where job_id=p_job and user_id=auth.uid() for update;
 if not found or not private.is_active() or not exists(select 1 from public.jobs where id=p_job and user_id=auth.uid() and status='done') then raise exception 'Unavailable' using errcode='42501';end if;
 if p.revision<>p_revision then raise exception 'Revision conflict' using errcode='40001';end if;
 perform private.podcast_duration(p.duration,p_edits);
 update public.podcast_edits set edits=p_edits,updated_at=now() where project_id=p_job and user_id=auth.uid();
 if not found then raise exception 'Unavailable';end if;
 update public.podcast_projects set revision=revision+1 where job_id=p_job;
 return p.revision+1;
end;$$;
revoke all on function public.save_podcast_edits(uuid,integer,jsonb) from public,anon;
grant execute on function public.save_podcast_edits(uuid,integer,jsonb) to authenticated;

create or replace function private.validate_job() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.studio_arrangements; j public.jobs; project_rec public.podcast_projects; e jsonb; t jsonb; cost integer;
begin
 if auth.uid() is null or new.user_id<>auth.uid() or not private.is_active() then raise exception 'Invalid job owner'; end if;
 if new.type='podcast_export' then
  select * into j from public.jobs where id=new.parent_job_id and user_id=auth.uid() and type='podcast' and status='done';
  select * into project_rec from public.podcast_projects where job_id=j.id and user_id=auth.uid() for update;
  if j.id is null or project_rec.job_id is null or project_rec.revision<>(new.settings->>'revision')::integer then raise exception 'Revision conflict' using errcode='40001';end if;
  select edits into e from public.podcast_edits where project_id=j.id;
  select transcript into t from public.podcast_transcripts where project_id=j.id;
  if e is null or t is null then raise exception 'Project unavailable';end if;
  new.export_free:=not exists(select 1 from public.jobs x where x.parent_job_id=j.id and x.export_free and x.status in ('queued','processing','done'));
  cost:=case when new.export_free then 0 else ceil(private.podcast_duration(project_rec.duration,e)/60)::integer end;
  if new.confirmed_export_minutes is distinct from cost then raise exception 'Export price changed; confirm again' using errcode='40001';end if;
  new.arrangement_snapshot:=jsonb_build_object('transcript',t,'edits',e,'duration',project_rec.duration,'source_path',project_rec.source_path);
  new.input_path:=new.user_id::text||'/'||j.id::text||'/export-'||new.id::text||'.json';return new;
 end if;
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
create or replace function private.export_is_free(job uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select export_free from public.jobs where id=job and type in ('studio_export','podcast_export')),false);
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
 if blocked or available is null or (available<1 and (j.type not in ('studio_export','podcast_export') or exists(select 1 from public.jobs x where x.parent_job_id=j.parent_job_id and x.export_free and x.status in ('processing','done')))) then
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
 if j.type in ('studio_export','podcast_export') then
  if j.type='studio_export' then perform 1 from public.studio_arrangements where job_id=j.parent_job_id for update;
  else perform 1 from public.podcast_projects where job_id=j.parent_job_id for update;end if;
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
 if j.type='podcast_export' then
  perform 1 from public.podcast_projects where job_id=j.parent_job_id for update;
  if (select exports_count from public.podcast_projects where job_id=j.parent_job_id)=0 then
   update public.jobs set export_free=true where id=j.id;
  elsif j.confirmed_export_minutes=0 then
   update public.jobs set status='failed',error='The included export was used elsewhere. Confirm the re-export cost.',finished_at=now() where id=j.id;return false;
  else update public.jobs set export_free=false where id=j.id;end if;
 end if;
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
 if j.type='podcast_export' then update public.podcast_projects set exports_count=exports_count+1 where job_id=j.parent_job_id;end if;
 if j.type='studio_export' then update public.studio_arrangements set exports_count=exports_count+1 where job_id=j.parent_job_id; end if;
 update public.jobs set status='done',output_paths=p_outputs,minutes_charged=cost,error=null,finished_at=now() where id=j.id;
 return true;
end;$$;
