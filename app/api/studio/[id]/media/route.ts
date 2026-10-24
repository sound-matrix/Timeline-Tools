import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { z } from "zod";
export async function GET(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  const clip = new URL(r.url).searchParams.get("clip");
  if (!z.uuid().safeParse(id).success || !clip || !/^c\d{1,3}$/.test(clip))
    return NextResponse.json({ error: "Unavailable" }, { status: 404 });
  const { data: job } = await db
    .from("jobs")
    .select("status,output_paths")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("type", "studio")
    .maybeSingle();
  const stem = `${user.id}/${id}/stems/${clip}.wav`,
    peaks = `${user.id}/${id}/peaks/${clip}.json`;
  if (
    job?.status !== "done" ||
    !job.output_paths?.includes(stem) ||
    !job.output_paths?.includes(peaks)
  )
    return NextResponse.json({ error: "Unavailable" }, { status: 404 });
  const [s, p] = await Promise.all([
    db.storage.from("outputs").createSignedUrl(stem, 60),
    db.storage.from("outputs").createSignedUrl(peaks, 60),
  ]);
  if (!s.data || !p.data)
    return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const kind = new URL(r.url).searchParams.get("kind");
  if (kind === "stem" || kind === "peaks")
    return NextResponse.redirect(
      kind === "stem" ? s.data.signedUrl : p.data.signedUrl,
      { headers: { "Cache-Control": "private, no-store" } },
    );
  return NextResponse.json(
    { stem: s.data.signedUrl, peaks: p.data.signedUrl },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
