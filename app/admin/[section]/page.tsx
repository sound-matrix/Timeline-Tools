import { requireAdmin } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import AdminEditor from "@/components/admin-editor";
import type { AdminEntity } from "@/lib/admin-schema";
const titles: Record<string, string> = {
  plans: "Plans & pricing",
  topup_packs: "Top-up packs",
  limits: "Usage limits per plan",
  coupons: "Coupons & discounts",
  users: "Users",
  jobs: "Jobs queue",
  audit_log: "Audit log",
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { db } = await requireAdmin(),
    { section } = await params;
  if (!titles[section]) notFound();
  const page = Math.max(
    1,
    Math.min(10000, Number((await searchParams).page) || 1),
  );
  const table =
    section === "limits" ? "plans" : section === "users" ? "profiles" : section;
  const { data, error } = await db
    .from(table)
    .select("*")
    .order(["jobs", "audit_log"].includes(section) ? "created_at" : "id", {
      ascending: !["jobs", "audit_log"].includes(section),
    })
    .range((page - 1) * 50, page * 50 - 1);
  if (error) throw error;
  const { data: plans } = await db.from("plans").select("id");
  const entity = (section === "limits" ? "plans" : section) as AdminEntity;
  return (
    <>
      <h2>{titles[section]}</h2>
      {["jobs", "audit_log"].includes(section) ? (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                {(section === "jobs"
                  ? ["ID", "User", "File", "Tool", "Status", "Created"]
                  : ["When", "Actor", "Action", "Entity", "Before / After"]
                ).map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.map((row) => (
                <tr key={row.id}>
                  {section === "jobs" ? (
                    <>
                      <td>{row.id}</td>
                      <td>{row.user_id}</td>
                      <td>{row.file_name}</td>
                      <td>
                        {row.type === "studio" ? "Audio Studio" : row.type}
                      </td>
                      <td>{row.status}</td>
                      <td>{row.created_at}</td>
                    </>
                  ) : (
                    <>
                      <td>{row.created_at}</td>
                      <td>{row.actor_id || "Database operator"}</td>
                      <td>{row.action}</td>
                      <td>
                        {row.entity} · {row.entity_id}
                      </td>
                      <td>
                        <details>
                          <summary>Changes</summary>
                          <pre>
                            {JSON.stringify(
                              {
                                before: row.before_data,
                                after: row.after_data,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.length && <p>No records yet.</p>}
        </div>
      ) : (
        <>
          {data?.map((row) =>
            section === "users" && ["admin", "owner"].includes(row.role) ? (
              <div className="card" key={row.id}>
                <b>{row.display_name || row.id}</b>
                <p>{row.role} · protected account</p>
              </div>
            ) : (
              <AdminEditor
                key={row.id}
                entity={entity}
                record={row}
                plans={plans?.map((p) => p.id)}
              />
            ),
          )}
          {["plans", "topup_packs", "coupons"].includes(section) && (
            <AdminEditor entity={entity} create />
          )}
        </>
      )}
      <div className="row">
        {page > 1 && (
          <Link href={`/admin/${section}?page=${page - 1}`}>Previous</Link>
        )}
        <span>Page {page}</span>
        {data?.length === 50 && (
          <Link href={`/admin/${section}?page=${page + 1}`}>Next</Link>
        )}
      </div>
    </>
  );
}
