import Link from "next/link";
type Job = {
  id: string;
  file_name: string;
  type: string;
  status: string;
  error: string | null;
  output_paths: unknown;
  created_at: string;
};
export default function JobsTable({ jobs }: { jobs: Job[] }) {
  return (
    <div className="card table-scroll">
      <h3>Recent jobs</h3>
      {!jobs.length ? (
        <p className="muted">No jobs yet. Upload a file to get started.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Tool</th>
              <th>Status</th>
              <th>Downloads</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  {j.file_name}
                  <small className="block muted">
                    {new Date(j.created_at).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                    })}{" "}
                    IST
                  </small>
                </td>
                <td>{j.type}</td>
                <td>
                  <span
                    className={
                      "tag " +
                      (j.status === "done"
                        ? "g"
                        : j.status === "failed"
                          ? "r"
                          : "y")
                    }
                  >
                    {j.status}
                  </span>
                  {j.error && <p>{j.error}</p>}
                </td>
                <td>
                  {j.status === "done" && Array.isArray(j.output_paths)
                    ? j.output_paths.map((_, i) => (
                        <Link
                          className="btn sm ghost"
                          key={i}
                          href={`/api/jobs/${j.id}/download?index=${i}`}
                        >
                          Download {i + 1}
                        </Link>
                      ))
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
