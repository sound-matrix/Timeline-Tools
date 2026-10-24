import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
export async function GET(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  const url = new URL(r.url),
    kind = url.searchParams.get("kind"),
    index = url.searchParams.get("index");
  if (
    !z.uuid().safeParse(id).success ||
    !["source", "peaks", "proxy", "clip", "clip_peaks"].includes(kind ?? "") ||
    (["proxy", "clip", "clip_peaks"].includes(kind ?? "") &&
      !/^\d{1,3}$/.test(index ?? ""))
  )
    return NextResponse.json({ error: "Unavailable" }, { status: 404 });
  const { data: job } = await db
    .from("jobs")
    .select("status,output_paths")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("type", "podcast")
    .maybeSingle();
  const name =
    kind === "source"
      ? "podcast-source.wav"
      : kind === "clip"
        ? `podcast-clip-${Number(index)}.wav`
        : kind === "clip_peaks"
          ? `podcast-clip-${Number(index)}-peaks.json`
          : kind === "peaks"
            ? "podcast-peaks.json"
            : `proxy-${Number(index)}.mp4`;
  const path = `${user.id}/${id}/${name}`;
  if (job?.status !== "done" || !job.output_paths?.includes(path))
    return NextResponse.json({ error: "Unavailable" }, { status: 404 });
  const { data, error } = await db.storage
    .from("outputs")
    .createSignedUrl(path, 3600);
  if (error || !data)
    return NextResponse.json(
      { error: "Media temporarily unavailable" },
      { status: 503 },
    );
  const response = NextResponse.redirect(data.signedUrl);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
