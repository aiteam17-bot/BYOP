import { connection } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/supabase/env";

// Health check: GET /api/health
//   200 {"status":"ok","database":"ok"}
//   503 {"status":"degraded","database":"unreachable"}
// It reveals nothing else: no versions, hosts, ids or error text.
// connection() makes it run on every request instead of at build time.
export async function GET() {
  await connection();
  let database: "ok" | "unreachable" = "unreachable";
  try {
    const { url, anonKey } = getSupabaseEnv();
    // No cookies and no session: health_check() is the one function signed-out
    // callers may run, and it only returns 'ok'.
    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase
      .rpc("health_check")
      .abortSignal(AbortSignal.timeout(3000));
    if (!error && data === "ok") database = "ok";
  } catch {
    database = "unreachable";
  }
  const ok = database === "ok";
  return Response.json(
    { status: ok ? "ok" : "degraded", database },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
