import { studioContext } from "@/lib/studio";
import AudioStudio from "@/components/audio-studio";
import ToolJobs from "@/components/tool-jobs";
import { jobDownloads, type ProcessingState } from "@/lib/job-status";

export default async function Page() {
  const { user, plan, db } = await studioContext();
  const { data: last } = await db
    .from("jobs")
    .select(
      "id,file_name,status,error,error_code,error_detail,duration_sec,output_paths",
    )
    .eq("user_id", user.id)
    .eq("type", "studio")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const initial: ProcessingState | null = last
    ? {
        id: last.id,
        fileName: last.file_name,
        status: last.status,
        error: last.error,
        errorCode: last.error_code,
        errorDetail: last.error_detail,
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
        <p className="eyebrow">YOUR SOUND, IN SYNC</p>
        <h2>Audio Studio</h2>
        <p className="muted">
          Upload your script and audio clips. Arrange by script, edit your
          timeline, then export your mix.
        </p>
      </div>
      <AudioStudio
        userId={user.id}
        maxMb={plan.max_file_mb}
        initial={initial}
      />
      <ToolJobs userId={user.id} type="studio" />
      <ToolJobs userId={user.id} type="studio_export" />
    </>
  );
}
