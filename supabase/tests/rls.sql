-- Run against a disposable/local Supabase database: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
-- Every fixture and mutation is rolled back, including on success.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('a1111111-1111-4111-8111-111111111111','rls-a@example.invalid','{"role":"owner","display_name":"Test A"}'),
 ('b2222222-2222-4222-8222-222222222222','rls-b@example.invalid','{}'),
 ('c3333333-3333-4333-8333-333333333333','rls-admin@example.invalid','{}');
update public.profiles set role='admin' where id='c3333333-3333-4333-8333-333333333333';
insert into storage.objects(bucket_id,name,metadata) values
 ('uploads','a1111111-1111-4111-8111-111111111111/a1111111-1111-4111-8111-111111111111.wav','{"size":1024}'),
 ('uploads','b2222222-2222-4222-8222-222222222222/b2222222-2222-4222-8222-222222222222.wav','{"size":1024}');
select set_config('request.jwt.claim.sub','a1111111-1111-4111-8111-111111111111',true);
set local role authenticated;
insert into public.jobs(file_name,input_path,type,settings) values ('a.wav','a1111111-1111-4111-8111-111111111111/a1111111-1111-4111-8111-111111111111.wav','clean','{}');
do $$begin
 if (select role from public.profiles where id=auth.uid())!='user' then raise exception 'Metadata role escalation';end if;
 if exists(select 1 from public.profiles where id='b2222222-2222-4222-8222-222222222222') then raise exception 'Cross-user profile read';end if;
 if exists(select 1 from storage.objects where name like 'b2222222%') then raise exception 'Cross-user storage read';end if;
 begin update public.profiles set role='owner' where id=auth.uid();raise exception 'Role escalation allowed';exception when insufficient_privilege then null;end;
 begin update public.profiles set plan_id='studio' where id=auth.uid();raise exception 'Plan escalation allowed';exception when insufficient_privilege then null;end;
 begin update public.profiles set minutes_balance=9999 where id=auth.uid();raise exception 'Credit escalation allowed';exception when insufficient_privilege then null;end;
 begin update public.profiles set suspended=false where id=auth.uid();raise exception 'Suspension bypass';exception when insufficient_privilege then null;end;
 begin update public.jobs set status='done';raise exception 'Job forgery';exception when insufficient_privilege then null;end;
 begin perform public.admin_save('users','b2222222-2222-4222-8222-222222222222','{"plan_id":"pro","minutes_balance":999,"suspended":false}');raise exception 'Admin bypass';exception when insufficient_privilege then null;end;
 begin insert into storage.objects(bucket_id,name,metadata) values('uploads','a1111111-1111-4111-8111-111111111111/a2222222-2222-4222-8222-222222222222.wav','{"size":209715201}');raise exception 'Oversize upload allowed';exception when insufficient_privilege then null;end;
 begin insert into storage.objects(bucket_id,name,metadata) values('outputs','a1111111-1111-4111-8111-111111111111/forged.wav','{"size":20}');raise exception 'Output forgery';exception when insufficient_privilege then null;end;
end;$$;
update public.profiles set display_name='Edited' where id=auth.uid();
select set_config('request.jwt.claim.sub','b2222222-2222-4222-8222-222222222222',true);
do $$begin
 if exists(select 1 from public.jobs) then raise exception 'Cross-user job read';end if;
end;$$;
insert into public.jobs(file_name,input_path,type,settings) values ('b.wav','b2222222-2222-4222-8222-222222222222/b2222222-2222-4222-8222-222222222222.wav','master','{}');
select set_config('request.jwt.claim.sub','c3333333-3333-4333-8333-333333333333',true);
select public.admin_save('users','b2222222-2222-4222-8222-222222222222','{"plan_id":"pro","minutes_balance":1200,"suspended":true}');
do $$begin
 if (select count(*) from public.jobs where file_name in ('a.wav','b.wav'))!=2 then raise exception 'Admin jobs access failed';end if;
 if not exists(select 1 from public.audit_log where actor_id=auth.uid() and entity='profiles' and after_data->>'minutes_balance'='1200.00') then raise exception 'Missing admin audit';end if;
end;$$;
select set_config('request.jwt.claim.sub','b2222222-2222-4222-8222-222222222222',true);
do $$begin
 if exists(select 1 from public.jobs) then raise exception 'Suspended user can read jobs';end if;
 if exists(select 1 from storage.objects) then raise exception 'Suspended user can read storage';end if;
end;$$;
reset role;
rollback;
select 'RLS tests passed (fixtures rolled back)' as result;
