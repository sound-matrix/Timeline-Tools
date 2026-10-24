import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { requestBody, privateHeaders, projectId } from "@/lib/editor/api";
import { z } from "zod";
const schema = z
  .object({
    id: z.uuid(),
    storage_path: z.string().max(300),
    peaks_path: z.string().max(300),
    name: z.string().min(1).max(255),
    mime: z.string().max(120),
    duration: z.number().finite().positive().max(14400),
    sample_rate: z.number().int().min(8000).max(192000),
    channels: z.number().int().min(1).max(2),
    bytes: z.number().int().positive(),
  })
  .strict();
export async function POST(
  r: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { db } = await requireUser();
  const { id } = await params;
  let body;
  try {
    body = schema.parse(await requestBody(r, 4096));
  } catch {
    return NextResponse.json({ error: "Invalid asset" }, { status: 400 });
  }
  if (!projectId.safeParse(id).success)
    return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  const { data, error } = await db.rpc("register_editor_asset", {
    p_project: id,
    p_asset: body.id,
    p_storage_path: body.storage_path,
    p_peaks_path: body.peaks_path,
    p_name: body.name,
    p_mime: body.mime,
    p_duration: body.duration,
    p_sample_rate: body.sample_rate,
    p_channels: body.channels,
    p_bytes: body.bytes,
  });
  return error
    ? NextResponse.json(
        {
          error:
            "Could not register upload. Check file ownership, upload completion and plan limits.",
        },
        { status: 400 },
      )
    : NextResponse.json({ id: data }, { status: 201, headers: privateHeaders });
}
