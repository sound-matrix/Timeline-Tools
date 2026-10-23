import { NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";
export async function GET(request: NextRequest) {
  const hash = request.nextUrl.searchParams.get("token_hash"),
    type = request.nextUrl.searchParams.get("type");
  if (hash && (type === "recovery" || type === "email" || type === "signup")) {
    const db = await serverClient();
    const { error } = await db.auth.verifyOtp({ token_hash: hash, type });
    if (!error)
      return NextResponse.redirect(
        new URL(
          type === "recovery" ? "/reset-password" : "/dashboard",
          request.url,
        ),
      );
  }
  return NextResponse.redirect(new URL("/auth/invalid", request.url));
}
