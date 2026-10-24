import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { arrangementSchema } from "@/lib/arrangement";
import { z } from "zod";
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
  const { data, error } = await db
    .from("studio_arrangements")
    .select("revision,arrangement,exports_count")
    .eq("job_id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data)
    return NextResponse.json(
      { error: "Arrangement unavailable" },
      { status: 404, headers },
    );
  const parsed = arrangementSchema.safeParse(data.arrangement);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid arrangement" },
      { status: 422, headers },
    );
  return NextResponse.json({ ...data, arrangement: parsed.data }, { headers });
}
export async function PUT(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (r.headers.get("origin") !== new URL(r.url).origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { db, user } = await requireUser();
  const { id } = await params;
  if (Number(r.headers.get("content-length") || 0) > 550000)
    return NextResponse.json({ error: "Too large" }, { status: 413 });
  let body;
  try {
    const raw = await r.text();
    if (new TextEncoder().encode(raw).length > 550000) throw Error();
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const a = arrangementSchema.safeParse(body.arrangement);
  if (
    !z.uuid().safeParse(id).success ||
    !a.success ||
    a.data.job_id !== id ||
    !Number.isInteger(body.revision)
  )
    return NextResponse.json({ error: "Invalid arrangement" }, { status: 400 });
  const { data: current } = await db
    .from("studio_arrangements")
    .select("arrangement")
    .eq("job_id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!current)
    return NextResponse.json({ error: "Unavailable" }, { status: 404 });
  const stored = arrangementSchema.safeParse(current.arrangement);
  if (!stored.success)
    return NextResponse.json(
      { error: "Stored arrangement unavailable" },
      { status: 422 },
    );
  if (
    JSON.stringify(stored.data.clips) !== JSON.stringify(a.data.clips) ||
    JSON.stringify(stored.data.lines) !== JSON.stringify(a.data.lines)
  )
    return NextResponse.json(
      { error: "Source metadata cannot change" },
      { status: 400 },
    );
  const { data, error } = await db.rpc("save_arrangement", {
    p_job: id,
    p_revision: body.revision,
    p_arrangement: a.data,
  });
  if (error)
    return NextResponse.json(
      {
        error:
          error.code === "40001"
            ? "This session changed elsewhere. Reload before editing."
            : "Could not save arrangement",
      },
      { status: error.code === "40001" ? 409 : 400 },
    );
  return NextResponse.json({ revision: data }, { headers });
}
