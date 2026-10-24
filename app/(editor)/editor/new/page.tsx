import { requireUser } from "@/lib/auth";
import EditorLaunch from "@/components/editor/launch";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; job?: string }>;
}) {
  await requireUser();
  const p = await searchParams;
  const source =
    p.source === "studio" || p.source === "podcast" ? p.source : "blank";
  return (
    <EditorLaunch
      source={source}
      job={source === "blank" ? null : (p.job ?? null)}
    />
  );
}
