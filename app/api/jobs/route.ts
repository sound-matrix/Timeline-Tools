import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { jobSchema, extensions } from "@/lib/settings";
import { withDefaults } from "@/lib/defaults";
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { db, user } = await requireUser();
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const parsed = jobSchema.safeParse({
    ...body,
    settings: withDefaults(body.type, body.settings),
  });
  if (!parsed.success)
    return NextResponse.json(
      {
        error: "Check the processing settings below.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  if (
    parsed.success &&
    ["studio_export", "podcast_export"].includes(parsed.data.type)
  ) {
    if (!Number.isInteger(body.expected_cost) || body.expected_cost < 0)
      return NextResponse.json(
        { error: "Confirm the export cost" },
        { status: 400 },
      );
    const { data: parent } = await db
      .from("jobs")
      .select("id")
      .eq("id", body.parent_job_id)
      .eq("user_id", user.id)
      .eq("type", parsed.data.type === "podcast_export" ? "podcast" : "studio")
      .eq("status", "done")
      .maybeSingle();
    if (!parent)
      return NextResponse.json(
        { error: "Parent unavailable" },
        { status: 404 },
      );
    const { data, error } = await db
      .from("jobs")
      .insert({
        ...parsed.data,
        parent_job_id: parent.id,
        confirmed_export_minutes: body.expected_cost,
        file_name:
          parsed.data.type === "podcast_export"
            ? "Podcast export"
            : "Studio export",
        input_path: `${user.id}/${parent.id}/export-${crypto.randomUUID()}.json`,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "40001") {
        const { data: active } = await db
          .from("jobs")
          .select("id")
          .eq("parent_job_id", parent.id)
          .eq("user_id", user.id)
          .eq("export_free", true)
          .in("status", ["queued", "processing", "done"])
          .limit(1);
        const { data: arr } = await db
          .from(
            parsed.data.type === "podcast_export"
              ? "podcast_projects"
              : "studio_arrangements",
          )
          .select("*")
          .eq("job_id", parent.id)
          .eq("user_id", user.id)
          .maybeSingle();
        return NextResponse.json(
          {
            error: "Session or export cost changed. Review and confirm again.",
            reason: error.message?.includes("price")
              ? "price_changed"
              : "revision_conflict",
            expected_cost: active?.length
              ? Math.ceil(
                  (arr?.arrangement?.duration ?? arr?.duration ?? 0) / 60,
                )
              : 0,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "Could not queue export" },
        { status: 400 },
      );
    }
    return NextResponse.json(data, { status: 201 });
  }
  if (
    !parsed.success ||
    typeof body.file_name !== "string" ||
    body.file_name.length > 255 ||
    !body.file_name.length ||
    typeof body.input_path !== "string" ||
    !body.input_path.startsWith(user.id + "/") ||
    !(["studio", "podcast"].includes(parsed.data.type)
      ? new RegExp(`^${user.id}/[0-9a-f-]+\\.zip$`).test(body.input_path)
      : extensions.includes(body.input_path.split(".").pop()?.toLowerCase()))
  )
    return NextResponse.json(
      { error: "Invalid file or processing settings" },
      { status: 400 },
    );
  const { data, error } = await db
    .from("jobs")
    .insert({
      file_name: body.file_name,
      input_path: body.input_path,
      ...parsed.data,
    })
    .select("id")
    .single();
  if (error)
    return NextResponse.json(
      { error: "Could not queue job. Check your upload and plan limits." },
      { status: 400 },
    );
  return NextResponse.json(data, { status: 201 });
}
