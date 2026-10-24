import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
export const privateHeaders = { "Cache-Control": "private, no-store" };
export const unavailable = () =>
  NextResponse.json(
    { error: "Project unavailable" },
    { status: 404, headers: privateHeaders },
  );
export async function requestBody(r: Request, limit = 1040000) {
  if (r.headers.get("origin") !== new URL(r.url).origin)
    throw Error("Invalid origin");
  if (Number(r.headers.get("content-length") ?? 0) > limit)
    throw Error("Request too large");
  if (!r.body) throw Error("Empty request");
  const reader = r.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("Request too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
export const projectId = z.uuid();
