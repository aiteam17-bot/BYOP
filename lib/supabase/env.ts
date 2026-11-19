// The only two Supabase values this app needs. Both are safe to expose to the
// browser: the anon/publishable key is protected by the row-level security
// policies in supabase/schema.sql. NEVER add the service-role key here.
export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function getSupabaseEnv() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Add them to .env.local (local) or Vercel Environment Variables (deployed).",
    );
  }
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}
