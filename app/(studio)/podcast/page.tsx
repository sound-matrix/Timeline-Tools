import { z } from "zod";
import { notFound } from "next/navigation";
import { studioContext } from "@/lib/studio";
import PodcastTool from "@/components/podcast-tool";
import ToolJobs from "@/components/tool-jobs";
import { jobDownloads, type ProcessingState } from "@/lib/job-status";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const requested = (await searchParams).session;
  if (requested && !z.uuid().safeParse(requested).success) notFound();
  const { user, db, plan } = await studioContext();
  let query = db
    .from("jobs")
    .select("*")
    .eq("user_id", user.id)
    .eq("type", "podcast");
  if (requested) query = query.eq("id", requested);
  const { data: last } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (requested && !last) notFound();
  const initial: ProcessingState | null = last
    ? {
        id: last.id,
        fileName: last.file_name,
        status: last.status,
        error: last.error,
        errorCode: last.error_code,
        durationSec: last.duration_sec,
        downloads:
          last.status === "done"
            ? jobDownloads(last.id, user.id, last.output_paths)
            : [],
      }
    : null;
  return (
    <>
      <div className="audio-studio-heading">
        <p className="eyebrow">VOICE INTO STORY</p>
        <h2>Podcast</h2>
        <p className="muted">
          Clean recordings, identify speakers and edit words on your timeline.
          Audio and video, in one session.
        </p>
      </div>
      <PodcastTool
        key={initial?.id??"new"}
        userId={user.id}
        maxMb={plan.max_file_mb}
        initial={initial}
      />
      <ToolJobs userId={user.id} type="podcast" />
      <ToolJobs userId={user.id} type="podcast_export" />
    </>
  );
}
