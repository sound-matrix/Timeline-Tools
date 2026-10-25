import JobsTable from "./jobs-table";
import { serverClient } from "@/lib/supabase/server";
export default async function ToolJobs({
  userId,
  type,
}: {
  userId: string;
  type: string;
}) {
  const db = await serverClient();
  const { data, error } = await db
    .from("jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  return (
    <JobsTable
      jobs={data ?? []}
      subtitleEditor={type === "subtitles"}
      title={type.endsWith("_export") ? "Recent exports" : "Recent jobs"}
    />
  );
}
