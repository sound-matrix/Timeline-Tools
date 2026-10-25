import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jobDownloads } from "@/lib/job-status";
const headers = { "Cache-Control": "private, no-store" };

// Restore the existing export on reload; this read never queues or bills a job.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db, user } = await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return NextResponse.json(
      { error: "Unavailable" },
      { status: 404, headers },
    );
  const { data: parent } = await db
    .from("jobs")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("type", "studio")
    .eq("status", "done")
    .maybeSingle();
  if (!parent)
    return NextResponse.json(
      { error: "Unavailable" },
      { status: 404, headers },
    );
  const { data: job, error } = await db
    .from("jobs")
    .select("id,file_name,status,error,duration_sec,output_paths")
    .eq("parent_job_id", id)
    .eq("user_id", user.id)
    .eq("type", "studio_export")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error)
    return NextResponse.json(
      { error: "Could not load consolidated audio." },
      { status: 503, headers },
    );
  return NextResponse.json(
    {
      result: job
        ? {
            id: job.id,
            fileName: job.file_name,
            status: job.status,
            error: job.error,
            durationSec: job.duration_sec,
            downloads:
              job.status === "done"
                ? jobDownloads(job.id, user.id, job.output_paths)
                : [],
          }
        : null,
    },
    { headers },
  );
}
