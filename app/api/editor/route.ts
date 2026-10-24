import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { requestBody, privateHeaders } from "@/lib/editor/api";
import { z } from "zod";
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120).default("Untitled project"),
    source_kind: z.enum(["blank", "studio", "podcast"]).default("blank"),
    source_job: z.uuid().nullable().default(null),
  })
  .strict();
export async function POST(r: Request) {
  const { db } = await requireUser();
  let body;
  try {
    body = createSchema.parse(await requestBody(r, 4096));
  } catch {
    return NextResponse.json(
      { error: "Invalid project request" },
      { status: 400 },
    );
  }
  const { data, error } = await db.rpc("create_editor_project", {
    p_name: body.name,
    p_source_kind: body.source_kind,
    p_source_job: body.source_job,
  });
  if (error)
    return NextResponse.json(
      {
        error:
          "Could not create project. Check that the Editor Studio migration has been applied and the source is saved.",
      },
      { status: 400, headers: privateHeaders },
    );
  return NextResponse.json(
    { id: data },
    { status: 201, headers: privateHeaders },
  );
}
