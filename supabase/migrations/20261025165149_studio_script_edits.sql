-- Reuse private subtitle edits for completed Audio Studio jobs.
-- Original worker outputs and arrangements remain immutable.
drop policy subtitle_edits_owner on public.subtitle_edits;
create policy subtitle_edits_owner on public.subtitle_edits for all to authenticated
using (user_id = (select auth.uid()) and (select private.is_active()) and exists (
  select 1 from public.jobs j where j.id = job_id and j.user_id = (select auth.uid()) and j.type in ('subtitles', 'studio') and j.status = 'done'
))
with check (user_id = (select auth.uid()) and (select private.is_active()) and exists (
  select 1 from public.jobs j where j.id = job_id and j.user_id = (select auth.uid()) and j.type in ('subtitles', 'studio') and j.status = 'done'
));
