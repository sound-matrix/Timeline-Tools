-- Keep export snapshots, billing references and stored asset ownership intact.
-- Deletion removes a project from the workspace; existing retention rules still apply.
alter table public.editor_projects add column archived_at timestamptz;
grant update(archived_at) on public.editor_projects to authenticated;
-- The existing editor_project_rename UPDATE policy restricts both columns to
-- the active owner, with USING and WITH CHECK. No service-role route is needed.
create index editor_projects_visible_owner on public.editor_projects(user_id,updated_at desc)
where archived_at is null;
