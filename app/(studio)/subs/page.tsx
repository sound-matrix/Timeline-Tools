import { studioContext } from "@/lib/studio";
import JobForm from "@/components/job-form";
export default async function Page() {
  const { user, plan } = await studioContext();
  return (
    <>
      <h2>Subtitles</h2>
      <p className="muted">
        Save your processing settings and queue a job. Processing arrives in
        Phase 1B.
      </p>
      <JobForm type="subtitles" maxMb={plan.max_file_mb} userId={user.id} />
    </>
  );
}
