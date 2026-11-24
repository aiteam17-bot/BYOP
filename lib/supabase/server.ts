import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getSupabaseEnv } from "./env";

// For Server Components, Server Actions and Route Handlers.
// Reads the signed-in user's session from cookies.
export async function createClient() {
  const cookieStore = await cookies();
  // cookies() alone is not enough: with partialPrefetching, Next pre-renders
  // at request time WITH cookies, and supabase-js then calls Date.now() (to
  // check the session's expiry) inside that pre-render, which Next rejects
  // ("encountered the unstable value Date.now() while prerendering").
  // connection() makes everything after it run only for the real request.
  await connection();
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
