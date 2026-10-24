-- Apply manually. No production DDL or deploy is performed by this change.
-- 1,000,000 bytes supports 2,000 whole regions plus metadata and stays below 1 MiB.
create table public.editor_projects (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id),
 name text not null check(length(name) between 1 and 120),
 source_kind text not null check(source_kind in ('blank','studio','podcast')),
 source_job_id uuid references public.jobs(id),
 source_arrangement jsonb, source_overlay jsonb,
 revision integer not null default 1 check(revision>0),
 arrangement jsonb not null check(jsonb_typeof(arrangement)='object' and octet_length(arrangement::text)<=1000000),
 exports_count integer not null default 0 check(exports_count>=0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check ((source_kind='blank')=(source_job_id is null)),
 unique(id,user_id)
);
create index editor_projects_owner on public.editor_projects(user_id,updated_at desc);
create table public.editor_assets (
 id uuid primary key,project_id uuid not null,user_id uuid not null,
 storage_path text not null unique,peaks_path text not null unique,
 name text not null check(length(name) between 1 and 255),mime text not null,
 duration numeric not null check(duration>0 and duration<=14400),
 sample_rate integer not null check(sample_rate between 8000 and 192000),
 channels integer not null check(channels between 1 and 2),bytes bigint not null check(bytes>0),
 created_at timestamptz not null default now(),
 foreign key(project_id,user_id) references public.editor_projects(id,user_id) on delete cascade
);
create index editor_assets_owner on public.editor_assets(user_id);
create index editor_assets_project on public.editor_assets(project_id);
create table public.editor_arrangement_versions (
 project_id uuid not null references public.editor_projects(id) on delete cascade,
 revision integer not null,user_id uuid not null references public.profiles(id),
 arrangement jsonb not null check(octet_length(arrangement::text)<=1000000),
 saved_at timestamptz not null default now(),primary key(project_id,revision)
);
alter table public.editor_projects enable row level security;
alter table public.editor_assets enable row level security;
alter table public.editor_arrangement_versions enable row level security;
revoke all on public.editor_projects,public.editor_assets,public.editor_arrangement_versions from public,anon,authenticated;
grant select on public.editor_projects,public.editor_assets,public.editor_arrangement_versions to authenticated;
grant all on public.editor_projects,public.editor_assets,public.editor_arrangement_versions to service_role;
create policy editor_projects_owner on public.editor_projects for select to authenticated using(user_id=(select auth.uid()) and (select private.is_active()));
create policy editor_assets_owner on public.editor_assets for select to authenticated using(user_id=(select auth.uid()) and (select private.is_active()));
create policy editor_versions_owner on public.editor_arrangement_versions for select to authenticated using(user_id=(select auth.uid()) and (select private.is_active()));

create function private.editor_version() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or new.revision<>old.revision then
  insert into public.editor_arrangement_versions(project_id,revision,user_id,arrangement) values(new.id,new.revision,new.user_id,new.arrangement);
  -- Last 50 plus one hourly checkpoint per hour during the past 24 hours (at most 74).
  delete from public.editor_arrangement_versions v where v.project_id=new.id and v.revision not in
   (select revision from public.editor_arrangement_versions where project_id=new.id order by revision desc limit 50)
   and v.revision not in
   (select max(revision) from public.editor_arrangement_versions where project_id=new.id and saved_at>now()-interval '24 hours' group by date_trunc('hour',saved_at));
 end if;
 return new;
end;$$;
revoke all on function private.editor_version() from public,anon,authenticated;
create trigger editor_version after insert or update on public.editor_projects for each row execute function private.editor_version();

create function public.create_editor_project(p_name text,p_source_kind text default 'blank',p_source_job uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare project uuid:=gen_random_uuid(); a jsonb; overlay jsonb; seconds numeric; cs jsonb; ls jsonb; rs jsonb; base jsonb;
begin
 if auth.uid() is null or not private.is_active() then raise exception 'Unavailable' using errcode='42501';end if;
 if p_name is null or length(trim(p_name)) not between 1 and 120 or p_source_kind not in ('blank','studio','podcast') or p_source_kind is null
 or (p_source_kind='blank') is distinct from (p_source_job is null) then raise exception 'Invalid project' using errcode='22023';end if;
 if p_source_kind<>'blank' then
  if not exists(select 1 from public.jobs where id=p_source_job and user_id=auth.uid() and type=p_source_kind and status='done') then raise exception 'Source unavailable' using errcode='42501';end if;
 end if;
 if p_source_kind='studio' then select arrangement into a from public.studio_arrangements where job_id=p_source_job and user_id=auth.uid();end if;
 if p_source_kind='podcast' then
  select jsonb_build_object('edits',e.edits,'transcript',t.transcript,'duration',p.duration,'media',(select jsonb_agg(jsonb_build_object('index',media_index,'name',name,'offset',offset_sec,'duration',duration,'has_proxy',proxy_path is not null) order by media_index) from public.podcast_media where project_id=p.job_id)) into overlay
   from public.podcast_projects p join public.podcast_edits e on e.project_id=p.job_id join public.podcast_transcripts t on t.project_id=p.job_id where p.job_id=p_source_job and p.user_id=auth.uid();
  a:=overlay->'edits'->'timeline';seconds:=(overlay->>'duration')::numeric;
  if a is null then
   select jsonb_agg(jsonb_build_object('id','c'||media_index,'name',name,'duration',duration,'offset',offset_sec) order by media_index) into cs from public.podcast_media where project_id=p_source_job and user_id=auth.uid() and audio_path is not null;
   if cs is null then cs:=jsonb_build_array(jsonb_build_object('id','source','name','Podcast source','duration',seconds));end if;
   select jsonb_agg(jsonb_build_object('id','t'||ordinality,'name',c->>'name','color','#818CF8','gain_db',0,'pan',0,'height',120,'inserts','[]'::jsonb,'mute',false,'solo',false)),
    jsonb_agg(jsonb_build_object('id','r'||ordinality,'lane','t'||ordinality,'kind','clip','clip',c->>'id','src_start',0,'src_end',c->'duration','start',coalesce(c->'offset','0'::jsonb),'gain_db',0,'line',0,'confidence',1,'mute',false,'fade_in',0,'fade_out',0,'fade_curve','linear','lines','[]'::jsonb)) into ls,rs from jsonb_array_elements(cs) with ordinality as t(c,ordinality);
  end if;
 end if;
 if p_source_kind='studio' and a is null or p_source_kind='podcast' and overlay is null then raise exception 'Source unavailable' using errcode='42501';end if;
 base:=a;
 if a is null then a:=jsonb_build_object('version',2,'job_id',project,'sample_rate',48000,'duration',coalesce(seconds,60),'snap',true,'pan_law','equal_power','legacy_mastering',false,'tempo',120,'time_signature',jsonb_build_array(4,4),'markers','[]'::jsonb,'loop',jsonb_build_object('enabled',false,'start',0,'end',coalesce(seconds,60)),'master',jsonb_build_object('gain_db',0,'reference_gain_db',0,'inserts','[]'::jsonb),'lanes',coalesce(ls,'[]'::jsonb),'clips',coalesce(cs,'[]'::jsonb),'regions',coalesce(rs,'[]'::jsonb),'missing','[]'::jsonb,'unplaced','[]'::jsonb,'lines','[]'::jsonb,'derived_clips','[]'::jsonb);base:=a;end if;
 a:=a||jsonb_build_object('job_id',project,'editor_project',true);
 insert into public.editor_projects(id,user_id,name,source_kind,source_job_id,source_arrangement,source_overlay,arrangement)
 values(project,auth.uid(),trim(p_name),p_source_kind,p_source_job,case when p_source_kind='blank' then null else base end,overlay,a);
 return project;
end;$$;
revoke all on function public.create_editor_project(text,text,uuid) from public,anon;
grant execute on function public.create_editor_project(text,text,uuid) to authenticated;

-- Preserve the legacy uploader and extend only the new Editor namespace.
alter function private.upload_allowed(text,jsonb) rename to legacy_upload_allowed;
create function private.upload_allowed(object_name text,object_metadata jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select case when split_part(object_name,'/',1)<>'editor' then private.legacy_upload_allowed(object_name,object_metadata) else
 auth.uid() is not null and private.is_active()
 and split_part(object_name,'/',2)=auth.uid()::text
 and object_name ~* '^editor/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(wav|mp3|flac|m4a|aac|aiff|aif|ogg|peaks)$'
 and exists(select 1 from public.editor_projects e join public.profiles p on p.id=e.user_id join public.plans pl on pl.id=p.plan_id
 where e.id::text=split_part(object_name,'/',3) and e.user_id=auth.uid() and pl.active
 and (object_metadata->>'size' is null or (object_metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576)) end;
$$;
revoke all on function private.upload_allowed(text,jsonb) from public,anon;
grant execute on function private.upload_allowed(text,jsonb) to authenticated;
-- Rebind the policy: renaming a function preserves existing policy dependencies.
drop policy upload_insert on storage.objects;
create policy upload_insert on storage.objects for insert to authenticated with check(bucket_id='uploads' and private.upload_allowed(name,metadata));
create policy editor_upload_read on storage.objects for select to authenticated using(bucket_id='uploads' and split_part(name,'/',1)='editor' and private.upload_allowed(name,metadata));

create or replace function private.enforce_upload_limit() returns trigger language plpgsql security definer set search_path='' as $$
declare owner_id text; quota bigint;
begin
 if new.bucket_id='uploads' and new.metadata->>'size' is not null then
  owner_id:=case when split_part(new.name,'/',1)='editor' then split_part(new.name,'/',2) else split_part(new.name,'/',1) end;
  -- Serialize final uploads on the owner to enforce the aggregate Editor quota.
  perform 1 from public.profiles where id::text=owner_id for update;
  select pl.max_file_mb::bigint*1048576 into quota from public.profiles p join public.plans pl on pl.id=p.plan_id where p.id::text=owner_id and not p.suspended and pl.active;
  if quota is null or (new.metadata->>'size')::bigint not between 1 and quota then raise exception 'Upload exceeds plan limit or account unavailable' using errcode='42501';end if;
  if split_part(new.name,'/',1)='editor' then
   if not exists(select 1 from public.editor_projects where id::text=split_part(new.name,'/',3) and user_id::text=owner_id)
   or new.name !~* '^editor/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(wav|mp3|flac|m4a|aac|aiff|aif|ogg|peaks)$'
   or coalesce((select sum((metadata->>'size')::bigint) from storage.objects where bucket_id='uploads' and name like 'editor/'||owner_id||'/%' and id<>new.id),0)+(new.metadata->>'size')::bigint>quota
   then raise exception 'Editor storage quota exceeded' using errcode='42501';end if;
  end if;
 end if;
 return new;
end;$$;

create function public.register_editor_asset(p_project uuid,p_asset uuid,p_storage_path text,p_peaks_path text,p_name text,p_mime text,p_duration numeric,p_sample_rate integer,p_channels integer,p_bytes bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare prefix text; stored bigint;
begin
 perform 1 from public.editor_projects where id=p_project and user_id=auth.uid() for update;
 if not found or not private.is_active() then raise exception 'Project unavailable' using errcode='42501';end if;
 prefix:='editor/'||auth.uid()::text||'/'||p_project::text||'/'||p_asset::text;
 if p_storage_path is null or p_storage_path !~* ('^'||prefix||'\.(wav|mp3|flac|m4a|aac|aiff|aif|ogg)$') or p_peaks_path is distinct from prefix||'.peaks' then raise exception 'Invalid asset path' using errcode='22023';end if;
 select (metadata->>'size')::bigint into stored from storage.objects where bucket_id='uploads' and name=p_storage_path;
 if stored is distinct from p_bytes or not exists(select 1 from storage.objects where bucket_id='uploads' and name=p_peaks_path and (metadata->>'size')::bigint>0) then raise exception 'Upload incomplete' using errcode='22023';end if;
 if exists(select 1 from public.editor_assets where id=p_asset and project_id=p_project and user_id=auth.uid() and storage_path=p_storage_path and peaks_path=p_peaks_path) then return p_asset;end if;
 insert into public.editor_assets(id,project_id,user_id,storage_path,peaks_path,name,mime,duration,sample_rate,channels,bytes) values(p_asset,p_project,auth.uid(),p_storage_path,p_peaks_path,p_name,p_mime,p_duration,p_sample_rate,p_channels,p_bytes);
 return p_asset;
end;$$;
revoke all on function public.register_editor_asset(uuid,uuid,text,text,text,text,numeric,integer,integer,bigint) from public,anon;
grant execute on function public.register_editor_asset(uuid,uuid,text,text,text,text,numeric,integer,integer,bigint) to authenticated;

create function public.save_editor_arrangement(p_project uuid,p_revision integer,p_arrangement jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare p public.editor_projects; c jsonb;
begin
 select * into p from public.editor_projects where id=p_project and user_id=auth.uid() for update;
 if not found or not private.is_active() then raise exception 'Project unavailable' using errcode='42501';end if;
 if p_revision is distinct from p.revision then raise exception 'Revision conflict' using errcode='40001';end if;
 if p_arrangement is null or jsonb_typeof(p_arrangement) is distinct from 'object' or octet_length(p_arrangement::text)>1000000
 or p_arrangement->>'version' not in ('1','2') or p_arrangement->>'version' is null
 or p_arrangement->>'job_id' is distinct from p_project::text
 or jsonb_typeof(p_arrangement->'clips') is distinct from 'array' then raise exception 'Invalid arrangement' using errcode='22023';end if;
 for c in select value from jsonb_array_elements(p_arrangement->'clips') loop
  if c ? 'asset' then
   if not exists(select 1 from public.editor_assets where id::text=c->>'asset' and project_id=p_project and user_id=auth.uid() and id::text=c->>'id' and duration=(c->>'duration')::numeric) then raise exception 'Invalid asset ownership' using errcode='42501';end if;
  elsif not exists(select 1 from jsonb_array_elements(p.source_arrangement->'clips') original where original=c) then raise exception 'Invalid source clip' using errcode='42501';end if;
 end loop;
 if p_arrangement=p.arrangement then return p.revision;end if;
 update public.editor_projects set arrangement=p_arrangement,revision=revision+1,updated_at=now() where id=p_project;
 return p.revision+1;
end;$$;
revoke all on function public.save_editor_arrangement(uuid,integer,jsonb) from public,anon;
grant execute on function public.save_editor_arrangement(uuid,integer,jsonb) to authenticated;

-- Editor cloud jobs reuse worker_prepare/worker_complete and their success-only charging.
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check(type in ('clean','master','subtitles','studio','studio_export','podcast','podcast_export','editor_export'));
alter table public.jobs add column editor_project_id uuid references public.editor_projects(id);
alter table public.jobs add constraint editor_export_project check((type='editor_export')=(editor_project_id is not null));
create index editor_export_jobs on public.jobs(editor_project_id) where type='editor_export';
grant insert(editor_project_id) on public.jobs to authenticated;

-- Source forks share the source's included export; making another fork cannot reset billing.
create function private.editor_export_count(p_project uuid) returns integer language plpgsql security definer set search_path='' as $$
declare p public.editor_projects; n integer;
begin
 select * into p from public.editor_projects where id=p_project for update;
 if not found then raise exception 'Unavailable';end if;
 if p.source_kind='studio' then select exports_count into n from public.studio_arrangements where job_id=p.source_job_id for update;
 elsif p.source_kind='podcast' then select exports_count into n from public.podcast_projects where job_id=p.source_job_id for update;
 else n:=p.exports_count;end if;
 return coalesce(n,0);
end;$$;
revoke all on function private.editor_export_count(uuid) from public,anon,authenticated;
grant execute on function private.editor_export_count(uuid) to service_role;
create or replace function private.validate_job() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.studio_arrangements; j public.jobs; project_rec public.podcast_projects; e jsonb; t jsonb; cost integer; ep public.editor_projects; ec integer; span numeric;
begin
 if auth.uid() is null or new.user_id<>auth.uid() or not private.is_active() then raise exception 'Invalid job owner'; end if;
 if new.type='editor_export' then
  select * into ep from public.editor_projects where id=new.editor_project_id and user_id=auth.uid() for update;
  if ep.id is null then raise exception 'Project unavailable' using errcode='42501';end if;
  if (new.settings->>'revision')::integer is distinct from ep.revision then raise exception 'Revision conflict' using errcode='40001';end if;
  if jsonb_typeof(new.settings->'range') is distinct from 'array' or jsonb_array_length(new.settings->'range')<>2 then raise exception 'Invalid range';end if;
  span:=(new.settings->'range'->>1)::numeric-(new.settings->'range'->>0)::numeric;
  if span is null or span<=0 or (new.settings->'range'->>0)::numeric<0 or (new.settings->'range'->>1)::numeric>(ep.arrangement->>'duration')::numeric then raise exception 'Invalid range';end if;
  ec:=private.editor_export_count(ep.id);
  new.parent_job_id:=ep.source_job_id;
  new.export_free:=ec=0 and not exists(select 1 from public.jobs x where (case when ep.source_job_id is null then x.editor_project_id=ep.id else x.parent_job_id=ep.source_job_id end) and x.export_free and x.status in ('queued','processing','done'));
  cost:=case when new.export_free then 0 else ceil(span/60)::integer end;
  if new.confirmed_export_minutes is distinct from cost then raise exception 'Export price changed; confirm again' using errcode='40001';end if;
  new.arrangement_snapshot:=jsonb_build_object('arrangement',ep.arrangement,'source_kind',ep.source_kind,'source_job_id',ep.source_job_id,'source_overlay',ep.source_overlay,'source_arrangement',ep.source_arrangement,'assets',(select coalesce(jsonb_agg(to_jsonb(ea)),'[]'::jsonb) from public.editor_assets ea where ea.project_id=ep.id and ea.user_id=auth.uid()));
  new.input_path:=new.user_id::text||'/'||ep.id::text||'/export-'||new.id::text||'.json';return new;
 end if;
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
create or replace function private.worker_prepare(p_job_id uuid,p_worker_id text,p_duration numeric) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.jobs; available numeric; blocked boolean; cost numeric;
begin
 select * into j from public.jobs where id=p_job_id and status='processing' and worker_id=p_worker_id for update;
 if not found then return false; end if;
 if p_duration is null or p_duration<=0 or p_duration::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid duration'; end if;
 if j.type='editor_export' then
  perform private.editor_export_count(j.editor_project_id);
  update public.jobs set export_free=not exists(select 1 from public.jobs x where x.id<>j.id and (case when j.parent_job_id is null then x.editor_project_id=j.editor_project_id else x.parent_job_id=j.parent_job_id end) and x.export_free and x.status in ('queued','processing','done')) where id=j.id;
 end if;
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
declare j public.jobs; cost numeric; ec integer; ep public.editor_projects;
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
 if j.type='editor_export' then
  ec:=private.editor_export_count(j.editor_project_id);
  if ec=0 then update public.jobs set export_free=true where id=j.id;
  elsif j.confirmed_export_minutes=0 then update public.jobs set status='failed',error='The included export was used elsewhere. Confirm the re-export cost.',finished_at=now() where id=j.id;return false;
  else update public.jobs set export_free=false where id=j.id;end if;
 end if;
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
 if j.type='editor_export' then
  update public.editor_projects set exports_count=exports_count+1 where id=j.editor_project_id returning * into ep;
  if ep.source_kind='studio' then update public.studio_arrangements set exports_count=exports_count+1 where job_id=ep.source_job_id;
  elsif ep.source_kind='podcast' then update public.podcast_projects set exports_count=exports_count+1 where job_id=ep.source_job_id;end if;
 end if;
 update public.jobs set status='done',output_paths=p_outputs,minutes_charged=cost,error=null,finished_at=now() where id=j.id;
 return true;
end;$$;
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
 if blocked or available is null or (available<1 and not (j.type='editor_export' and j.export_free) and (j.type not in ('studio_export','podcast_export') or exists(select 1 from public.jobs x where x.parent_job_id=j.parent_job_id and x.export_free and x.status in ('processing','done')))) then
  update public.jobs set status='failed',error=case when blocked then 'Account or plan unavailable' else 'Insufficient minutes' end,finished_at=now() where id=j.id;
  return;
 end if;
 return query update public.jobs set status='processing',started_at=now(),worker_id=p_worker_id,error=null where id=j.id returning *;
end;$$;

create or replace function private.export_is_free(job uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select export_free from public.jobs where id=job and type in ('studio_export','podcast_export','editor_export')),false);
$$;
