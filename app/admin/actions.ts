"use server";
import { requireAdmin } from "@/lib/auth";
import { adminSchemas, type AdminEntity } from "@/lib/admin-schema";
import { revalidatePath } from "next/cache";
export async function saveAdmin(
  entity: AdminEntity,
  id: string,
  payload: unknown,
): Promise<{ error?: string }> {
  const { db } = await requireAdmin();
  if (!Object.hasOwn(adminSchemas, entity)) return { error: "Invalid section" };
  const parsed = adminSchemas[entity].safeParse(payload);
  if (!parsed.success)
    return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  if (
    entity === "plans"
      ? !/^[a-z0-9_-]{1,40}$/.test(id)
      : id !== "" && !/^[0-9a-f-]{36}$/i.test(id)
  )
    return { error: "Invalid ID" };
  const { error } = await db.rpc("admin_save", {
    entity,
    record_id: id,
    payload: parsed.data,
  });
  if (error)
    return {
      error:
        "Save failed. Check the values and that the account is not protected.",
    };
  revalidatePath("/admin", "layout");
  revalidatePath("/dashboard");
  revalidatePath("/plans");
  return {};
}
