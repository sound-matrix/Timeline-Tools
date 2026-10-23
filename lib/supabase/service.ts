import "server-only";
import { createClient } from "@supabase/supabase-js";
// Reserved for trusted Phase 1B workers. Never import from a client component.
export function serviceClient() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Missing service key");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
