import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { privateHeaders, projectId, unavailable } from "@/lib/editor/api";
export async function GET(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  const q = new URL(r.url).searchParams,
    clip = q.get("clip"),
    kind = q.get("kind") ?? "audio";
  if (
    !projectId.safeParse(id).success ||
    !clip ||
    !["audio", "peaks"].includes(kind)
  )
    return unavailable();
  const { data: project } = await db
    .from("editor_projects")
    .select("source_kind,source_job_id,arrangement")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!project) return unavailable();
  const c = project.arrangement.clips.find(
    (c: { id: string }) => c.id === clip,
  );
  if (!c) return unavailable();
  if (c.asset) {
    const { data: a } = await db
      .from("editor_assets")
      .select("storage_path,peaks_path")
      .eq("id", c.asset)
      .eq("project_id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!a) return unavailable();
    const { data } = await db.storage
      .from("uploads")
      .createSignedUrl(kind === "peaks" ? a.peaks_path : a.storage_path, 60);
    return data
      ? NextResponse.redirect(data.signedUrl, { headers: privateHeaders })
      : unavailable();
  }
  if (!project.source_job_id) return unavailable();
  let destination: string;
  if (project.source_kind === "studio")
    destination = `/api/studio/${project.source_job_id}/media?clip=${encodeURIComponent(clip)}&kind=${kind === "peaks" ? "peaks" : "stem"}`;
  else if (clip === "source")
    destination = `/api/podcast/${project.source_job_id}/media?kind=${kind === "peaks" ? "peaks" : "source"}`;
  else if (/^c\d+$/.test(clip))
    destination = `/api/podcast/${project.source_job_id}/media?kind=${kind === "peaks" ? "clip_peaks" : "clip"}&index=${clip.slice(1)}`;
  else return unavailable();
  return NextResponse.redirect(new URL(destination, r.url), {
    headers: privateHeaders,
  });
}
