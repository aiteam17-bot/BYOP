import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "./env";

// For Server Components, Server Actions and Route Handlers.
// Reads the signed-in user's session from cookies.
export async function createClient() {
  // Read cookies first: this marks the caller as request-time (dynamic) so
  // Next.js does not try to run it while prerendering at build time.
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component, which cannot set cookies.
          // Safe to ignore: proxy.ts refreshes the session on every request.
        }
      },
    },
  });
}
