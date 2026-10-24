import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { transcriptSchema, editsSchema, validEdits } from "@/lib/podcast";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(
  _r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return NextResponse.json(
      { error: "Unavailable" },
      { status: 404, headers },
    );
  const [
    { data: project },
    { data: transcript },
    { data: edits },
    { data: media },
  ] = await Promise.all([
    db
      .from("podcast_projects")
      .select("duration,revision,exports_count")
      .eq("job_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
    db
      .from("podcast_transcripts")
      .select("transcript")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
    db
      .from("podcast_edits")
      .select("edits")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
    db
      .from("podcast_media")
      .select("media_index,name,offset_sec,duration,proxy_path")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .order("media_index"),
  ]);
  const t = transcriptSchema.safeParse(transcript?.transcript),
    e = editsSchema.safeParse(edits?.edits);
  if (!project || !t.success || !e.success)
    return NextResponse.json(
      { error: "Podcast unavailable" },
      { status: 404, headers },
    );
  return NextResponse.json(
    {
      ...project,
      transcript: t.data,
      edits: e.data,
      media: (media ?? []).map((m) => ({
        index: m.media_index,
        name: m.name,
        offset: Number(m.offset_sec),
        duration: Number(m.duration),
        proxy: m.proxy_path
          ? `/api/podcast/${id}/media?kind=proxy&index=${m.media_index}`
          : null,
      })),
      audio: `/api/podcast/${id}/media?kind=source`,
      peaks: `/api/podcast/${id}/media?kind=peaks`,
    },
    { headers },
  );
}
export async function PUT(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (r.headers.get("origin") !== new URL(r.url).origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { db, user } = await requireUser();
  const { id } = await params;
  let body;
  try {
    const raw = await r.text();
    if (new TextEncoder().encode(raw).length > 4194304) throw Error();
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid edits" }, { status: 400 });
  }
  const e = editsSchema.safeParse(body?.edits);
  if (
    !z.uuid().safeParse(id).success ||
    !e.success ||
    !Number.isInteger(body?.revision)
  )
    return NextResponse.json({ error: "Invalid edits" }, { status: 400 });
  const [{ data: p }, { data: t }] = await Promise.all([
    db
      .from("podcast_projects")
      .select("duration")
      .eq("job_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
    db
      .from("podcast_transcripts")
      .select("transcript")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);
  const transcript = transcriptSchema.safeParse(t?.transcript);
  if (!p || !transcript.success)
    return NextResponse.json({ error: "Unavailable" }, { status: 404 });
  if (!validEdits(e.data, transcript.data, Number(p.duration)))
    return NextResponse.json(
      { error: "Invalid edit range or transcript reference" },
      { status: 400 },
    );
  const { data, error } = await db.rpc("save_podcast_edits", {
    p_job: id,
    p_revision: body.revision,
    p_edits: e.data,
  });
  if (error)
    return NextResponse.json(
      {
        error:
          error.code === "40001"
            ? "Session changed elsewhere. Reload before editing."
            : "Could not save edits",
      },
      { status: error.code === "40001" ? 409 : 400 },
    );
  return NextResponse.json({ revision: data }, { headers });
}
