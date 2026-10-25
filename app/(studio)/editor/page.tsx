import { requireUser } from "@/lib/auth";
import EditorProjects from "@/components/editor/projects";
export default async function Page() {
  const { db, user } = await requireUser();
  const { data, error } = await db
    .from("editor_projects")
    .select("id,name,updated_at")
    .eq("user_id", user.id)
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return <EditorProjects projects={data ?? []} />;
}
