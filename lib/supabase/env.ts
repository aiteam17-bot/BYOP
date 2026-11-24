// The only two Supabase values this app needs. Both are safe to expose to the
// browser: the publishable (or legacy anon) key is protected by the row-level
// security policies in supabase/schema.sql. NEVER add a secret/service-role key.
//
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is preferred; older projects can keep
// using NEXT_PUBLIC_SUPABASE_ANON_KEY. Next.js inlines NEXT_PUBLIC_* values at
// build time, so each one has to be read with its full literal name.
export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function getSupabaseEnv() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY " +
        "(or the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY). " +
        "Add them to .env.local (local) or Vercel Environment Variables (deployed). " +
        "Redeploy after changing them.",
    );
  }
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}
