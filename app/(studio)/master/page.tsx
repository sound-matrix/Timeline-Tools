import { studioContext } from "@/lib/studio";
import JobForm from "@/components/job-form";
import ToolJobs from "@/components/tool-jobs";
export default async function Page() {
  const { user, plan } = await studioContext();
  return (
    <>
      <h2>Mastering</h2>
      <p className="muted">
        Upload, choose your settings and start processing. Completed files are
        private to your account.
      </p>
      <JobForm type="master" maxMb={plan.max_file_mb} userId={user.id} />
      <ToolJobs userId={user.id} type="master" />
    </>
  );
}
