-- Forward-only Phase 1B. Browser table/column grants and RLS stay unchanged.
alter table public.jobs
 add column started_at timestamptz,
 add column finished_at timestamptz,
 add column worker_id text,
 add column minutes_charged numeric(12,2) not null default 0 check(minutes_charged>=0);
create index jobs_queue_oldest on public.jobs(created_at,id) where status='queued';
create index jobs_processing_started on public.jobs(started_at) where status='processing';
grant usage on schema private to service_role;

create function private.worker_claim(p_worker_id text) returns setof public.jobs
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
 if blocked or available is null or available<1 then
  update public.jobs set status='failed',error=case when blocked then 'Account or plan unavailable' else 'Insufficient minutes' end,finished_at=now() where id=j.id;
  return;
 end if;
 return query update public.jobs set status='processing',started_at=now(),worker_id=p_worker_id,error=null where id=j.id returning *;
end;$$;

-- Preflight after ffprobe, before expensive processing. Final completion rechecks
-- under a profile row lock, so concurrent jobs cannot overspend the balance.
create function private.worker_prepare(p_job_id uuid,p_worker_id text,p_duration numeric) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.jobs; available numeric; blocked boolean; cost numeric;
begin
 select * into j from public.jobs where id=p_job_id and status='processing' and worker_id=p_worker_id for update;
 if not found then return false; end if;
 if p_duration is null or p_duration<=0 or p_duration::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid duration'; end if;
 cost:=ceil(p_duration/60.0);
 select p.minutes_balance,(p.suspended or not pl.active) into available,blocked
 from public.profiles p join public.plans pl on pl.id=p.plan_id where p.id=j.user_id for update of p;
 if blocked or available is null or available<cost then
  update public.jobs set status='failed',duration_sec=p_duration,error=case when blocked then 'Account or plan unavailable' else 'Insufficient minutes' end,finished_at=now() where id=j.id;
  return false;
 end if;
 update public.jobs set duration_sec=p_duration where id=j.id;
 return true;
end;$$;

create function private.worker_complete(p_job_id uuid,p_worker_id text,p_outputs jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.jobs; cost numeric;
begin
 select * into j from public.jobs where id=p_job_id and status='processing' and worker_id=p_worker_id for update;
 if not found then return false; end if;
 if j.duration_sec is null or j.duration_sec<=0 then raise exception 'Duration required'; end if;
 if p_outputs is null or jsonb_typeof(p_outputs)!='array' then raise exception 'Invalid outputs'; end if;
 if jsonb_array_length(p_outputs) not between 1 and 4 then raise exception 'Invalid outputs'; end if;
 if exists(select 1 from jsonb_array_elements(p_outputs) v where jsonb_typeof(v)!='string')
 or exists(select 1 from jsonb_array_elements_text(p_outputs) v where
  v not like j.user_id::text||'/'||j.id::text||'/%' or v ~ '(^|/)\.\.(/|$)' or
  not exists(select 1 from storage.objects o where o.bucket_id='outputs' and o.name=v))
 then raise exception 'Invalid output ownership'; end if;
 cost:=ceil(j.duration_sec/60.0);
 update public.profiles p set minutes_balance=p.minutes_balance-cost
 where p.id=j.user_id and not p.suspended and p.minutes_balance>=cost
 and exists(select 1 from public.plans pl where pl.id=p.plan_id and pl.active);
 if not found then
  update public.jobs set status='failed',error=case when exists(select 1 from public.profiles p join public.plans pl on pl.id=p.plan_id where p.id=j.user_id and not p.suspended and pl.active) then 'Insufficient minutes' else 'Account or plan unavailable' end,finished_at=now() where id=j.id;
  return false;
 end if;
 update public.jobs set status='done',output_paths=p_outputs,minutes_charged=cost,error=null,finished_at=now() where id=j.id;
 return true;
end;$$;

create function private.worker_fail(p_job_id uuid,p_worker_id text,p_code text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update public.jobs set status='failed',finished_at=now(),error=case p_code
 when 'invalid_media' then 'Unable to read audio from this file'
 when 'invalid_settings' then 'Invalid processing settings'
 when 'storage' then 'File transfer failed. Please try again.'
 when 'timeout' then 'Processing timed out. Please submit again.'
 else 'Processing failed. Please try again.' end
 where id=p_job_id and status='processing' and worker_id=p_worker_id;
 return found;
end;$$;

-- Non-privileged public wrappers, EXECUTE only for the service role.
create function public.worker_claim(p_worker_id text) returns setof public.jobs
language sql security invoker set search_path='' as $$ select * from private.worker_claim(p_worker_id); $$;
create function public.worker_prepare(p_job_id uuid,p_worker_id text,p_duration numeric) returns boolean
language sql security invoker set search_path='' as $$ select private.worker_prepare(p_job_id,p_worker_id,p_duration); $$;
create function public.worker_complete(p_job_id uuid,p_worker_id text,p_outputs jsonb) returns boolean
language sql security invoker set search_path='' as $$ select private.worker_complete(p_job_id,p_worker_id,p_outputs); $$;
create function public.worker_fail(p_job_id uuid,p_worker_id text,p_code text) returns boolean
language sql security invoker set search_path='' as $$ select private.worker_fail(p_job_id,p_worker_id,p_code); $$;
revoke all on function private.worker_claim(text),public.worker_claim(text),
 private.worker_prepare(uuid,text,numeric),public.worker_prepare(uuid,text,numeric),
 private.worker_complete(uuid,text,jsonb),public.worker_complete(uuid,text,jsonb),
 private.worker_fail(uuid,text,text),public.worker_fail(uuid,text,text) from public,anon,authenticated;
grant execute on function private.worker_claim(text),public.worker_claim(text),
 private.worker_prepare(uuid,text,numeric),public.worker_prepare(uuid,text,numeric),
 private.worker_complete(uuid,text,jsonb),public.worker_complete(uuid,text,jsonb),
 private.worker_fail(uuid,text,text),public.worker_fail(uuid,text,text) to service_role;
