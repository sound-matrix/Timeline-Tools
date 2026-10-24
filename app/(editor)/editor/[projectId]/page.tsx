import { studioContext } from "@/lib/studio";
import { notFound } from "next/navigation";
import EditorStudio from "@/components/editor/editor-studio";
import { z } from "zod";
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { db, user, plan } = await studioContext();
  if (!z.uuid().safeParse(projectId).success) notFound();
  const { data } = await db
    .from("editor_projects")
    .select("id,name")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) notFound();
  return (
    <EditorStudio
      projectId={projectId}
      userId={user.id}
      name={data.name}
      maxMb={plan.max_file_mb}
    />
  );
}
