import { requireUser } from "@/lib/auth";
export async function studioContext() {
  const ctx = await requireUser();
  const { data: plan, error } = await ctx.db
    .from("plans")
    .select("*")
    .eq("id", ctx.profile.plan_id)
    .single();
  if (error || !plan)
    throw new Error("Your plan is unavailable. Contact your administrator.");
  return { ...ctx, plan };
}
