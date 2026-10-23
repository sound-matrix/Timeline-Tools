import { studioContext } from "@/lib/studio";
import JobForm from "@/components/job-form";
import JobsTable from "@/components/jobs-table";
export default async function Page() {
  const { db, user, profile, plan } = await studioContext();
  const {
    data: jobs,
    error,
    count,
  } = await db
    .from("jobs")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (
    <>
      <h2>Dashboard</h2>
      <div className="grid">
        <div className="card stat">
          <b>{profile.minutes_balance}</b>
          <span>minutes left · {plan.name}</span>
        </div>
        <div className="card stat">
          <b>{count ?? 0}</b>
          <span>jobs submitted</span>
        </div>
        <div className="card stat">
          <b>-14 LUFS</b>
          <span>default mastering target</span>
        </div>
      </div>
      <p className="muted">
        Uploads are saved securely. Jobs remain queued until Phase 1B processing
        is enabled. No minutes are deducted yet.
      </p>
      <JobForm maxMb={plan.max_file_mb} userId={user.id} controls={false} />
      <JobsTable jobs={jobs ?? []} />
      <p className="muted">Showing your latest 100 jobs.</p>
    </>
  );
}
