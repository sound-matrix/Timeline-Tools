create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.plans (
 id text primary key check(id ~ '^[a-z0-9_-]+$'), name text not null,
 price_inr numeric(12,2) not null default 0 check(price_inr>=0),
 monthly_minutes integer not null check(monthly_minutes>=0),
 max_file_mb integer not null check(max_file_mb between 1 and 10000),
 features text not null default '', active boolean not null default true
);
create table public.topup_packs (
 id uuid primary key default gen_random_uuid(), name text not null,
 minutes integer not null check(minutes>0), price_inr numeric(12,2) not null check(price_inr>=0), active boolean not null default true
);
create table public.coupons (
 id uuid primary key default gen_random_uuid(), code text unique not null check(code ~ '^[A-Z0-9_-]{2,40}$'),
 type text not null check(type in ('percent','flat')), value numeric(12,2) not null check(value>0),
 expires_at timestamptz not null, usage_cap integer not null check(usage_cap>0), used integer not null default 0 check(used>=0),
 active boolean not null default true, check(type!='percent' or value<=100)
);
insert into public.plans values
 ('free','Free',0,30,200,'Noise removal',true),
 ('creator','Creator',499,300,1000,'Clean-up, mastering, subtitles',true),
 ('pro','Pro',1499,1200,4000,'Higher monthly allowance',true),
 ('studio','Studio',4999,5000,10000,'Studio allowance',true);
insert into public.topup_packs(name,minutes,price_inr) values ('Starter',60,199),('Booster',300,799),('Mega',1200,2499);
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default '' check(length(display_name)<=100),
 role text not null default 'user' check(role in ('user','admin','support','owner')),
 plan_id text not null default 'free' references public.plans(id),
 minutes_balance numeric(12,2) not null default 30 check(minutes_balance>=0),
 suspended boolean not null default false
);
create table public.jobs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references public.profiles(id),
 file_name text not null check(length(file_name) between 1 and 255), input_path text not null unique,
 output_paths jsonb not null default '[]'::jsonb check(jsonb_typeof(output_paths)='array'),
 type text not null check(type in ('clean','master','subtitles')), settings jsonb not null default '{}' check(jsonb_typeof(settings)='object' and octet_length(settings::text)<=8192),
 status text not null default 'queued' check(status in ('queued','processing','done','failed')),
 error text, duration_sec numeric check(duration_sec>=0), created_at timestamptz not null default now()
);
create index jobs_user_created on public.jobs(user_id,created_at desc);
create index profiles_plan on public.profiles(plan_id);
create table public.audit_log (
 id bigint generated always as identity primary key, actor_id uuid, action text not null,
 entity text not null, entity_id text, before_data jsonb, after_data jsonb, created_at timestamptz not null default now()
);
create index audit_created on public.audit_log(created_at desc);

create function private.is_admin() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','owner') and not suspended);
$$;
create function private.is_active() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.profiles where id=auth.uid() and not suspended);
$$;
revoke all on function private.is_admin(),private.is_active() from public;
grant execute on function private.is_admin(),private.is_active() to authenticated;

create function private.create_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,display_name,minutes_balance) values(new.id,left(coalesce(new.raw_user_meta_data->>'display_name',''),100),(select monthly_minutes from public.plans where id='free'));
 return new;
end;$$;
revoke all on function private.create_profile() from public;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.create_profile();
-- Backfill accounts that existed before the app was installed, without copying metadata roles.
insert into public.profiles(id,display_name) select id,left(coalesce(raw_user_meta_data->>'display_name',''),100) from auth.users on conflict(id) do nothing;

alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.topup_packs enable row level security;
alter table public.coupons enable row level security;
alter table public.jobs enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.profiles,public.plans,public.topup_packs,public.coupons,public.jobs,public.audit_log from anon,authenticated;
grant select on public.profiles,public.plans,public.topup_packs,public.coupons,public.jobs,public.audit_log to authenticated;
grant update(display_name) on public.profiles to authenticated;
grant insert(file_name,input_path,type,settings) on public.jobs to authenticated;
create policy profile_read on public.profiles for select to authenticated using(id=(select auth.uid()) or (select private.is_admin()));
create policy profile_edit on public.profiles for update to authenticated using(id=(select auth.uid()) and (select private.is_active())) with check(id=(select auth.uid()) and (select private.is_active()));
create policy plan_read on public.plans for select to authenticated using(active or (select private.is_admin()));
create policy pack_read on public.topup_packs for select to authenticated using(active or (select private.is_admin()));
create policy coupon_admin on public.coupons for select to authenticated using((select private.is_admin()));
create policy audit_admin on public.audit_log for select to authenticated using((select private.is_admin()));
create policy jobs_read on public.jobs for select to authenticated using((user_id=(select auth.uid()) and (select private.is_active())) or (select private.is_admin()));
create policy jobs_insert on public.jobs for insert to authenticated with check(user_id=(select auth.uid()) and (select private.is_active()) and status='queued' and output_paths='[]'::jsonb and error is null and duration_sec is null);

create function private.audit_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_log(actor_id,action,entity,entity_id,before_data,after_data)
 values(auth.uid(),tg_op,tg_table_name,coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id'),case when tg_op!='INSERT' then to_jsonb(old) end,case when tg_op!='DELETE' then to_jsonb(new) end);
 return coalesce(new,old);
end;$$;
revoke all on function private.audit_change() from public;
create trigger audit_plans after insert or update or delete on public.plans for each row execute function private.audit_change();
create trigger audit_packs after insert or update or delete on public.topup_packs for each row execute function private.audit_change();
create trigger audit_coupons after insert or update or delete on public.coupons for each row execute function private.audit_change();
create trigger audit_profiles after update on public.profiles for each row execute function private.audit_change();

-- Narrow administrative RPC: no role changes, arbitrary SQL, or client-supplied actor IDs.
create function public.admin_save(entity text, record_id text, payload jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
 case entity
 when 'plans' then
 insert into public.plans(id,name,price_inr,monthly_minutes,max_file_mb,features,active)
 values(record_id,payload->>'name',(payload->>'price_inr')::numeric,(payload->>'monthly_minutes')::integer,(payload->>'max_file_mb')::integer,coalesce(payload->>'features',''),(payload->>'active')::boolean)
 on conflict(id) do update set name=excluded.name,price_inr=excluded.price_inr,monthly_minutes=excluded.monthly_minutes,max_file_mb=excluded.max_file_mb,features=excluded.features,active=excluded.active;
 when 'topup_packs' then
 insert into public.topup_packs(id,name,minutes,price_inr,active)
 values(coalesce(nullif(record_id,'')::uuid,gen_random_uuid()),payload->>'name',(payload->>'minutes')::integer,(payload->>'price_inr')::numeric,(payload->>'active')::boolean)
 on conflict(id) do update set name=excluded.name,minutes=excluded.minutes,price_inr=excluded.price_inr,active=excluded.active;
 when 'coupons' then
 insert into public.coupons(id,code,type,value,expires_at,usage_cap,active)
 values(coalesce(nullif(record_id,'')::uuid,gen_random_uuid()),upper(payload->>'code'),payload->>'type',(payload->>'value')::numeric,(payload->>'expires_at')::timestamptz,(payload->>'usage_cap')::integer,(payload->>'active')::boolean)
 on conflict(id) do update set code=excluded.code,type=excluded.type,value=excluded.value,expires_at=excluded.expires_at,usage_cap=excluded.usage_cap,active=excluded.active;
 when 'users' then
 -- Operations staff cannot suspend/alter privileged accounts or themselves.
 update public.profiles set minutes_balance=(payload->>'minutes_balance')::numeric,plan_id=payload->>'plan_id',suspended=(payload->>'suspended')::boolean
 where id=record_id::uuid and role in ('user','support') and id<>auth.uid();
 if not found then raise exception 'User unavailable or protected'; end if;
 else raise exception 'Unsupported entity';
 end case;
end;$$;
revoke all on function public.admin_save(text,text,jsonb) from public,anon;
grant execute on function public.admin_save(text,text,jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit) values ('uploads','uploads',false,10485760000),('outputs','outputs',false,10485760000);
-- Storage performs a permission probe without metadata before writing bytes.
-- Its final INSERT carries authoritative size metadata; reject oversize finalization.
create function private.upload_allowed(object_name text, object_metadata jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
 and split_part(object_name,'/',1)=auth.uid()::text
 and object_name ~* '^[0-9a-f-]+/[0-9a-f-]+\.(wav|mp3|m4a|flac|aac|ogg|mp4|mov|mkv|webm)$'
 and exists(select 1 from public.profiles p join public.plans pl on pl.id=p.plan_id
 where p.id=auth.uid() and not p.suspended and pl.active
 and (object_metadata is null or ((object_metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576)));
$$;
revoke all on function private.upload_allowed(text,jsonb) from public;
grant execute on function private.upload_allowed(text,jsonb) to authenticated;
create policy upload_insert on storage.objects for insert to authenticated with check(bucket_id='uploads' and private.upload_allowed(name,metadata));
create policy media_read on storage.objects for select to authenticated using(bucket_id in ('uploads','outputs') and (storage.foldername(name))[1]=(select auth.uid())::text and (select private.is_active()));
create policy upload_delete on storage.objects for delete to authenticated using(bucket_id='uploads' and (storage.foldername(name))[1]=(select auth.uid())::text and (select private.is_active()) and not exists(select 1 from public.jobs where input_path=name));
-- No client UPDATE/upsert or output INSERT: only trusted workers can write outputs.
create function private.validate_job() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or new.user_id<>auth.uid() or not private.is_active() then raise exception 'Invalid job owner'; end if;
 if not exists(select 1 from storage.objects o join public.profiles p on p.id=new.user_id join public.plans pl on pl.id=p.plan_id
 where o.bucket_id='uploads' and o.name=new.input_path and split_part(o.name,'/',1)=new.user_id::text
 and (o.metadata->>'size')::bigint between 1 and pl.max_file_mb::bigint*1048576 and pl.active)
 then raise exception 'Upload missing or exceeds plan limit'; end if;
 return new;
end;$$;
revoke all on function private.validate_job() from public;
create trigger validate_job before insert on public.jobs for each row execute function private.validate_job();
