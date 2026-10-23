import { requireUser } from "@/lib/auth";
import { NextResponse } from "next/server";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  const index = Number(new URL(request.url).searchParams.get("index") ?? 0);
  const { data: job } = await db
    .from("jobs")
    .select("status,output_paths")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  const path = job?.output_paths?.[index];
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    job?.status !== "done" ||
    typeof path !== "string" ||
    !path.startsWith(user.id + "/")
  )
    return NextResponse.json({ error: "Output unavailable" }, { status: 404 });
  const { data, error } = await db.storage
    .from("outputs")
    .createSignedUrl(path, 60, { download: true });
  if (error || !data)
    return NextResponse.json({ error: "Output unavailable" }, { status: 404 });
  const response = NextResponse.redirect(data.signedUrl);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
