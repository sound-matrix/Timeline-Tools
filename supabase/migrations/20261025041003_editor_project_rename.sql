-- Renaming is the only direct project mutation. Arrangement saves retain revision RPCs.
grant update(name) on public.editor_projects to authenticated;
create policy editor_project_rename on public.editor_projects for update to authenticated
using(user_id=(select auth.uid()) and (select private.is_active()))
with check(user_id=(select auth.uid()) and (select private.is_active()));
