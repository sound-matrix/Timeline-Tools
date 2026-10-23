import { requireAdmin } from "@/lib/auth";
export default async function Page() {
  const { db } = await requireAdmin();
  const [users, jobs, queue] = await Promise.all([
    db.from("profiles").select("id", { count: "exact", head: true }),
    db.from("jobs").select("id", { count: "exact", head: true }),
    db
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued"),
  ]);
  if (users.error || jobs.error || queue.error)
    throw new Error("Unable to load overview");
  return (
    <>
      <h2>Overview</h2>
      <div className="grid">
        {[
          [users.count, "Users"],
          [jobs.count, "Total jobs"],
          [queue.count, "Queued jobs"],
        ].map(([v, l]) => (
          <div className="card stat" key={l}>
            <b>{v}</b>
            <span>{l}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Phase 1A</h3>
        <p>
          Uploads and settings are live. Processing, billing and automatic
          minute deductions are reserved for later phases.
        </p>
        <p>
          Every admin change is saved with an audit record in the same database
          transaction.
        </p>
      </div>
    </>
  );
}
