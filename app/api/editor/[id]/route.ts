import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { arrangementSchema } from "@/lib/arrangement";
import {
  requestBody,
  privateHeaders,
  projectId,
  unavailable,
} from "@/lib/editor/api";
export async function GET(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  if (!projectId.safeParse(id).success) return unavailable();
  const [{ data: project }, { data: assets }, { data: versions }] =
    await Promise.all([
      db
        .from("editor_projects")
        .select("*")
        .eq("id", id)
        .eq("user_id", user.id)
        .is("archived_at", null)
        .maybeSingle(),
      db
        .from("editor_assets")
        .select("*")
        .eq("project_id", id)
        .eq("user_id", user.id),
      db
        .from("editor_arrangement_versions")
        .select("revision,saved_at")
        .eq("project_id", id)
        .eq("user_id", user.id)
        .order("revision", { ascending: false })
        .limit(74),
    ]);
  if (!project) return unavailable();
  const version = new URL(r.url).searchParams.get("version");
  if (version) {
    const { data } = await db
      .from("editor_arrangement_versions")
      .select("arrangement")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .eq("revision", Number(version))
      .maybeSingle();
    if (!data) return unavailable();
    return NextResponse.json(data, { headers: privateHeaders });
  }
  let count = project.exports_count;
  if (project.source_job_id) {
    const { data: source } = await db
      .from(
        project.source_kind === "studio"
          ? "studio_arrangements"
          : "podcast_projects",
      )
      .select("exports_count")
      .eq("job_id", project.source_job_id)
      .eq("user_id", user.id)
      .maybeSingle();
    count = source?.exports_count ?? count;
  }
  let active = db
    .from("jobs")
    .select("id")
    .eq("user_id", user.id)
    .eq("export_free", true)
    .in("status", ["queued", "processing", "done"])
    .limit(1);
  active = project.source_job_id
    ? active.eq("parent_job_id", project.source_job_id)
    : active.eq("editor_project_id", id);
  const { data: reserved } = await active;
  if (reserved?.length) count = Math.max(count, 1);
  const a = arrangementSchema.safeParse(project.arrangement);
  if (!a.success)
    return NextResponse.json(
      { error: "Invalid saved arrangement" },
      { status: 422 },
    );
  return NextResponse.json(
    {
      ...project,
      exports_count: count,
      arrangement: a.data,
      assets: assets ?? [],
      versions: versions ?? [],
    },
    { headers: privateHeaders },
  );
}
export async function PUT(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db } = await requireUser();
  const { id } = await params;
  let body;
  try {
    body = await requestBody(r);
  } catch {
    return NextResponse.json(
      { error: "Invalid save request" },
      { status: 400 },
    );
  }
  const a = arrangementSchema.safeParse(body?.arrangement);
  if (
    !projectId.safeParse(id).success ||
    !a.success ||
    a.data.job_id !== id ||
    !Number.isInteger(body.revision) ||
    body.revision < 1
  )
    return NextResponse.json({ error: "Invalid arrangement" }, { status: 400 });
  const { data, error } = await db.rpc("save_editor_arrangement", {
    p_project: id,
    p_revision: body.revision,
    p_arrangement: a.data,
  });
  if (error)
    return NextResponse.json(
      {
        error:
          error.code === "40001"
            ? "Newer version from another tab"
            : "Could not save. Imported audio must finish uploading before it can be saved.",
      },
      { status: error.code === "40001" ? 409 : 400, headers: privateHeaders },
    );
  return NextResponse.json({ revision: data }, { headers: privateHeaders });
}

export async function PATCH(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  let body;
  try {
    body = await requestBody(r, 4096);
  } catch {
    return NextResponse.json(
      { error: "Invalid rename request" },
      { status: 400, headers: privateHeaders },
    );
  }
  if (
    !projectId.safeParse(id).success ||
    typeof body?.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 120 ||
    Object.keys(body).some((k) => k !== "name")
  )
    return NextResponse.json(
      { error: "Invalid project name" },
      { status: 400, headers: privateHeaders },
    );
  const { data, error } = await db
    .from("editor_projects")
    .update({ name: body.name.trim() })
    .is("archived_at", null)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id,name")
    .maybeSingle();
  if (error || !data) return unavailable();
  return NextResponse.json(data, { headers: privateHeaders });
}

export async function DELETE(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  try {
    await requestBody(r, 4096);
  } catch {
    return NextResponse.json(
      { error: "Invalid delete request" },
      { status: 400, headers: privateHeaders },
    );
  }
  if (!projectId.safeParse(id).success) return unavailable();
  const { data, error } = await db
    .from("editor_projects")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();
  if (error || !data) return unavailable();
  return NextResponse.json({ id: data.id }, { headers: privateHeaders });
}
