import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jobDownloads, jobStatusSchema } from "@/lib/job-status";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  const headers = { "Cache-Control": "private, no-store" };
  if (!z.uuid().safeParse(id).success)
    return NextResponse.json(
      { error: "Job unavailable." },
      { status: 404, headers },
    );
  const { data: job, error } = await db
    .from("jobs")
    .select("status,error,error_code,error_detail,output_paths,duration_sec")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error)
    return NextResponse.json(
      { error: "Could not check progress. Retrying shortly." },
      { status: 503, headers },
    );
  if (!job)
    return NextResponse.json(
      { error: "Job unavailable." },
      { status: 404, headers },
    );
  const snapshot = jobStatusSchema.safeParse({
    status: job.status,
    error: job.error,
    errorCode: job.error_code ?? null,
    errorDetail: job.error_detail ?? null,
    durationSec:
      typeof job.duration_sec === "number" &&
      Number.isFinite(job.duration_sec) &&
      job.duration_sec > 0
        ? job.duration_sec
        : null,
    downloads:
      job.status === "done" ? jobDownloads(id, user.id, job.output_paths) : [],
  });
  if (!snapshot.success)
    return NextResponse.json(
      { error: "Could not check progress. Retrying shortly." },
      { status: 503, headers },
    );
  return NextResponse.json(snapshot.data, { headers });
}
