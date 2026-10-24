import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  privateHeaders,
  projectId,
  requestBody,
  unavailable,
} from "@/lib/editor/api";
import { editorExportSchema } from "@/lib/editor/export";
export async function POST(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  let body;
  try {
    body = editorExportSchema.parse(await requestBody(r, 8192));
  } catch {
    return NextResponse.json(
      { error: "Check the export range and encoding options." },
      { status: 400 },
    );
  }
  if (!projectId.safeParse(id).success) return unavailable();
  const { data: project } = await db
    .from("editor_projects")
    .select("source_job_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!project) return unavailable();
  const { expected_cost, ...settings } = body;
  const { data, error } = await db
    .from("jobs")
    .insert({
      type: "editor_export",
      editor_project_id: id,
      parent_job_id: project.source_job_id,
      file_name: "Editor export",
      input_path: `${user.id}/${id}/export-${crypto.randomUUID()}.json`,
      settings,
      confirmed_export_minutes: expected_cost,
    })
    .select("id")
    .single();
  if (error)
    return NextResponse.json(
      {
        error:
          error.code === "40001"
            ? "Project or export cost changed. Save and review the cloud quote before confirming again."
            : "Could not queue cloud export.",
      },
      { status: error.code === "40001" ? 409 : 400, headers: privateHeaders },
    );
  return NextResponse.json(data, { status: 201, headers: privateHeaders });
}
