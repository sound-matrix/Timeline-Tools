-- Original worker outputs remain immutable. Edits are private to the job owner.
create table public.subtitle_edits (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cues jsonb not null check (jsonb_typeof(cues) = 'array' and octet_length(cues::text) <= 2097152),
  updated_at timestamptz not null default now()
);
create index subtitle_edits_user_id_idx on public.subtitle_edits(user_id);
alter table public.subtitle_edits enable row level security;
revoke all on public.subtitle_edits from public, anon, authenticated;
grant select, insert, update, delete on public.subtitle_edits to authenticated;
create policy subtitle_edits_owner on public.subtitle_edits for all to authenticated
using (user_id = (select auth.uid()) and (select private.is_active()) and exists (
  select 1 from public.jobs j where j.id = job_id and j.user_id = (select auth.uid()) and j.type = 'subtitles' and j.status = 'done'
))
with check (user_id = (select auth.uid()) and (select private.is_active()) and exists (
  select 1 from public.jobs j where j.id = job_id and j.user_id = (select auth.uid()) and j.type = 'subtitles' and j.status = 'done'
));
