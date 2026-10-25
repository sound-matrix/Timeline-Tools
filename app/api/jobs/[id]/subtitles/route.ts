import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonCues, validateCues } from "@/lib/subtitles";
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };
async function owned(context: Context) {
  const { db, user } = await requireUser();
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return null;
  const { data: job } = await db
    .from("jobs")
    .select("type,status,input_path")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  return job?.type === "subtitles" && job.status === "done"
    ? { db, user, id, job }
    : null;
}
export async function GET(_request: Request, context: Context) {
  const ctx = await owned(context);
  if (!ctx)
    return NextResponse.json(
      { error: "Subtitles unavailable." },
      { status: 404, headers },
    );
  const { db, user, id, job } = ctx;
  const { data, error } = await db
    .from("subtitle_edits")
    .select("cues,updated_at")
    .eq("job_id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error)
    return NextResponse.json(
      { error: "Saved edits could not be loaded. Please retry." },
      { status: 503, headers },
    );
  let audioUrl: string | null = null;
  if (
    typeof job.input_path === "string" &&
    job.input_path.startsWith(user.id + "/")
  ) {
    const { data: media } = await db.storage
      .from("uploads")
      .createSignedUrl(job.input_path, 3600);
    audioUrl = media?.signedUrl ?? null;
  }
  return NextResponse.json({ cues: data?.cues ?? null, audioUrl }, { headers });
}
export async function PUT(request: Request, context: Context) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return NextResponse.json(
      { error: "Invalid origin" },
      { status: 403, headers },
    );
  const ctx = await owned(context);
  if (!ctx)
    return NextResponse.json(
      { error: "Subtitles unavailable." },
      { status: 404, headers },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return NextResponse.json(
      { error: "Expected JSON." },
      { status: 415, headers },
    );
  let cues;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
      throw new Error();
    cues = jsonCues(JSON.parse(text).cues);
    if (validateCues(cues).some((e) => e.length)) throw new Error();
  } catch {
    return NextResponse.json(
      {
        error: "Fix invalid cue text or timings before saving (maximum 2 MB).",
      },
      { status: 400, headers },
    );
  }
  const { error } = await ctx.db.from("subtitle_edits").upsert(
    {
      job_id: ctx.id,
      user_id: ctx.user.id,
      cues,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "job_id" },
  );
  return error
    ? NextResponse.json(
        { error: "Could not save edits. Retry saving." },
        { status: 503, headers },
      )
    : NextResponse.json({ saved: true }, { headers });
}
