import "server-only";
import { cache } from "react";
import { serverClient } from "./supabase/server";
import { redirect } from "next/navigation";
export const requireUser = cache(async function requireUser() {
  const db = await serverClient();
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user) redirect("/signin");
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  if (profileError || !profile)
    throw new Error("Your profile could not be loaded. Please try again.");
  if (profile.suspended) redirect("/suspended");
  return { db, user, profile };
});
export async function requireAdmin() {
  const ctx = await requireUser();
  if (!["admin", "owner"].includes(ctx.profile.role)) redirect("/dashboard");
  return ctx;
}
