-- New projects retain independent cleaned source clips; old mixed-source jobs still load.
alter table public.podcast_media add column if not exists audio_path text;
alter table public.podcast_media add column if not exists peaks_path text;
-- Apply manually after review. Existing owner SELECT policies/grants remain in force.
-- A row lock in save_arrangement serializes revision checks and identical-save checks.
create or replace function public.save_arrangement(p_job uuid,p_revision integer,p_arrangement jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare a public.studio_arrangements;
begin
 select * into a from public.studio_arrangements where job_id=p_job and user_id=auth.uid() for update;
 if not found or not private.is_active() then raise exception 'Arrangement unavailable' using errcode='42501'; end if;
 if a.revision<>p_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
 if octet_length(p_arrangement::text)>524288 or jsonb_typeof(p_arrangement)<>'object'
 or coalesce(p_arrangement->>'version','') not in ('1','2')
 or p_arrangement->'clips' is distinct from a.arrangement->'clips'
 or p_arrangement->'lines' is distinct from a.arrangement->'lines'
 or p_arrangement->'job_id' is distinct from a.arrangement->'job_id'
 then raise exception 'Invalid arrangement'; end if;
 if p_arrangement=a.arrangement then return a.revision; end if;
 update public.studio_arrangements set arrangement=p_arrangement,revision=revision+1,updated_at=now() where job_id=p_job;
 return a.revision+1;
end;$$;
revoke all on function public.save_arrangement(uuid,integer,jsonb) from public,anon;
grant execute on function public.save_arrangement(uuid,integer,jsonb) to authenticated;

alter table public.studio_arrangement_versions add column if not exists saved_at timestamptz not null default now();
create index if not exists studio_versions_retention on public.studio_arrangement_versions(job_id,revision desc);
create or replace function private.version_arrangement() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or new.revision<>old.revision then
  insert into public.studio_arrangement_versions(job_id,revision,user_id,arrangement) values(new.job_id,new.revision,new.user_id,new.arrangement);
  -- A strict bound (50) is predictable even during long editing sessions.
  delete from public.studio_arrangement_versions v where v.job_id=new.job_id and v.revision not in
   (select revision from public.studio_arrangement_versions where job_id=new.job_id order by revision desc limit 50);
 end if;
 return new;
end;$$;
revoke all on function private.version_arrangement() from public,anon,authenticated;
-- Bound existing histories too; do not wait for the next edit.
delete from public.studio_arrangement_versions v using
 (select job_id,revision,row_number() over(partition by job_id order by revision desc) n from public.studio_arrangement_versions) ranked
where v.job_id=ranked.job_id and v.revision=ranked.revision and ranked.n>50;

-- Existing Podcast RLS remains in force. The source-bound timeline lives inside edits JSON.
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
 if p_edits ? 'timeline' then
  if jsonb_typeof(p_edits->'timeline') is distinct from 'object'
  or p_edits->'timeline'->>'version' is distinct from '2'
  or jsonb_array_length(p_edits->'timeline'->'clips') not between 1 and 200 then raise exception 'Invalid podcast timeline';end if;
  a:=(p_edits->'timeline'->>'duration')::numeric-removed+added;
 else a:=p_duration-removed+added;end if;
 if a is null or a<=0 or a>14400 then raise exception 'Invalid output duration';end if;
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
 if p_edits ? 'timeline' then
  if p_edits->'timeline'->'clips'->0->>'id'='source' then
   if jsonb_array_length(p_edits->'timeline'->'clips')<>1 or (p_edits->'timeline'->'clips'->0->>'duration')::numeric is distinct from p.duration then raise exception 'Invalid source';end if;
  elsif p_edits->'timeline'->'clips' is distinct from
    (select jsonb_agg(jsonb_build_object('id','c'||media_index,'name',name,'duration',duration,'offset',offset_sec) order by media_index) from public.podcast_media where project_id=p_job and user_id=auth.uid() and audio_path is not null)
  then raise exception 'Source metadata cannot change';end if;
 end if;
 if p_edits->'timeline'->>'job_id' is not null and p_edits->'timeline'->>'job_id'<>p_job::text then raise exception 'Invalid podcast job';end if;
 if exists(select 1 from public.podcast_edits where project_id=p_job and edits=p_edits) then return p.revision;end if;
 update public.podcast_edits set edits=p_edits,updated_at=now() where project_id=p_job and user_id=auth.uid();
 if not found then raise exception 'Unavailable';end if;
 update public.podcast_projects set revision=revision+1 where job_id=p_job;
 return p.revision+1;
end;$$;
revoke all on function public.save_podcast_edits(uuid,integer,jsonb) from public,anon;
grant execute on function public.save_podcast_edits(uuid,integer,jsonb) to authenticated;


-- Snapshot immutable media paths atomically with the unchanged export-price checks.
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
  new.arrangement_snapshot:=jsonb_build_object('transcript',t,'edits',e,'duration',project_rec.duration,'source_path',project_rec.source_path,'media',(select jsonb_agg(to_jsonb(m) order by media_index) from public.podcast_media m where project_id=j.id and user_id=auth.uid()));
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
