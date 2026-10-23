import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { jobSchema, extensions } from "@/lib/settings";
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
  const parsed = jobSchema.safeParse(body);
  if (
    !parsed.success ||
    typeof body.file_name !== "string" ||
    body.file_name.length > 255 ||
    !body.file_name.length ||
    typeof body.input_path !== "string" ||
    !body.input_path.startsWith(user.id + "/") ||
    !extensions.includes(body.input_path.split(".").pop()?.toLowerCase())
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
