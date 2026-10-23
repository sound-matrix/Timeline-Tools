import { requireUser } from "@/lib/auth";
export default async function Page() {
  const { db, profile } = await requireUser();
  const [{ data: plans, error }, { data: packs, error: packError }] =
    await Promise.all([
      db.from("plans").select("*").eq("active", true).order("price_inr"),
      db.from("topup_packs").select("*").eq("active", true).order("price_inr"),
    ]);
  if (error || packError) throw error || packError;
  return (
    <>
      <h2>Plans & billing</h2>
      <div className="card">
        Current plan: <b>{profile.plan_id}</b> · {profile.minutes_balance}{" "}
        minutes available
      </div>
      <div className="grid">
        {plans?.map((p) => (
          <div className="card price" key={p.id}>
            <h3>{p.name}</h3>
            <b>₹{p.price_inr}</b>
            <span className="muted">/month</span>
            <p>
              {p.monthly_minutes} min/month · {p.max_file_mb} MB files
            </p>
            <p>{p.features}</p>
          </div>
        ))}
      </div>
      <h3>Top-up packs</h3>
      <div className="grid">
        {packs?.map((p) => (
          <div className="card" key={p.id}>
            <b>{p.name}</b>
            <p>
              {p.minutes} minutes · ₹{p.price_inr}
            </p>
          </div>
        ))}
      </div>
      <p className="muted">
        Plan prices are informational. Checkout and top-up purchases are not
        enabled in Phase 1A.
      </p>
    </>
  );
}
