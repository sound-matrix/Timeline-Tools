"use server";
import { serverClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
export async function signOut() {
  const db = await serverClient();
  const { error } = await db.auth.signOut();
  if (error) throw new Error("Could not sign out. Please try again.");
  redirect("/signin");
}
