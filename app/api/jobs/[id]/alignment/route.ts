import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { alignmentReportSchema } from "@/lib/audio-studio";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  const headers = { "Cache-Control": "private, no-store" };
  const unavailable = () =>
    NextResponse.json(
      { error: "Alignment unavailable." },
      { status: 404, headers },
    );
  if (!z.uuid().safeParse(id).success) return unavailable();
  const { data: job } = await db
    .from("jobs")
    .select("type,status,output_paths")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  const path = `${user.id}/${id}/alignment-report.json`;
  if (
    job?.type !== "studio" ||
    job.status !== "done" ||
    !Array.isArray(job.output_paths) ||
    !job.output_paths.includes(path)
  )
    return unavailable();
  const { data, error } = await db.storage.from("outputs").download(path);
  if (error || !data || data.size > 1024 * 1024) return unavailable();
  try {
    const parsed = alignmentReportSchema.safeParse(
      JSON.parse(await data.text()),
    );
    if (!parsed.success) return unavailable();
    return NextResponse.json(parsed.data, { headers });
  } catch {
    return unavailable();
  }
}
