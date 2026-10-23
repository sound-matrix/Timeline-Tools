"use client";
import { useState } from "react";
import { saveAdmin } from "@/app/admin/actions";
import type { AdminEntity } from "@/lib/admin-schema";
type RecordData = Record<string, string | number | boolean | null>;
const fields: Record<AdminEntity, string[]> = {
  plans: [
    "name",
    "price_inr",
    "monthly_minutes",
    "max_file_mb",
    "features",
    "active",
  ],
  topup_packs: ["name", "minutes", "price_inr", "active"],
  coupons: ["code", "type", "value", "expires_at", "usage_cap", "active"],
  users: ["plan_id", "minutes_balance", "suspended"],
};
const labels: Record<string, string> = {
  price_inr: "Price (₹)",
  monthly_minutes: "Minutes / month",
  max_file_mb: "Max file (MB)",
  minutes_balance: "Credits (minutes)",
  expires_at: "Expires at (UTC)",
  usage_cap: "Usage cap",
  plan_id: "Plan ID",
};
export default function AdminEditor({
  entity,
  record = {},
  create = false,
  plans = [],
}: {
  entity: AdminEntity;
  record?: RecordData;
  create?: boolean;
  plans?: string[];
}) {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(e.currentTarget);
    const payload = Object.fromEntries(
      fields[entity].map((key) => [
        key,
        ["active", "suspended"].includes(key) ? form.has(key) : form.get(key),
      ]),
    );
    try {
      const result = await saveAdmin(
        entity,
        String(record.id || form.get("id") || ""),
        payload,
      );
      setMessage(result.error || "Saved.");
    } catch {
      setMessage("Unable to save. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>
        {create
          ? "Add " +
            (entity === "topup_packs"
              ? "top-up pack"
              : entity === "plans"
                ? "plan"
                : "coupon")
          : String(
              record.name || record.display_name || record.code || record.id,
            )}
      </h3>
      {entity === "users" && (
        <p className="muted">
          User ID: {String(record.id)} · Role: {String(record.role)}
        </p>
      )}
      <fieldset disabled={busy}>
        <div className="grid">
          {create && entity === "plans" && (
            <label>
              Plan ID
              <input name="id" required pattern="[a-z0-9_-]+" maxLength={40} />
            </label>
          )}
          {fields[entity].map((key) => (
            <label key={key}>
              {labels[key] || key.replaceAll("_", " ")}
              {["active", "suspended"].includes(key) ? (
                <input
                  name={key}
                  type="checkbox"
                  defaultChecked={
                    record[key] === undefined ? key === "active" : !!record[key]
                  }
                />
              ) : key === "type" ? (
                <select
                  name={key}
                  defaultValue={String(record[key] || "percent")}
                >
                  <option value="percent">Percent</option>
                  <option value="flat">Flat ₹</option>
                </select>
              ) : key === "plan_id" ? (
                <select name={key} defaultValue={String(record[key] || "free")}>
                  {plans.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              ) : (
                <input
                  name={key}
                  required={key !== "features"}
                  defaultValue={
                    key === "expires_at" && record[key]
                      ? String(record[key]).slice(0, 16)
                      : String(record[key] ?? "")
                  }
                  type={
                    [
                      "price_inr",
                      "monthly_minutes",
                      "max_file_mb",
                      "minutes",
                      "value",
                      "usage_cap",
                      "minutes_balance",
                    ].includes(key)
                      ? "number"
                      : key === "expires_at"
                        ? "datetime-local"
                        : "text"
                  }
                  min={
                    key === "max_file_mb" ||
                    key === "minutes" ||
                    key === "usage_cap" ||
                    key === "value"
                      ? 1
                      : 0
                  }
                  step={
                    ["price_inr", "value", "minutes_balance"].includes(key)
                      ? "0.01"
                      : undefined
                  }
                />
              )}
            </label>
          ))}
        </div>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </fieldset>
      <p role="status">{message}</p>
    </form>
  );
}
