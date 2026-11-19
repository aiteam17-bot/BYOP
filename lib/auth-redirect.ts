// After signing in, send people back to the page they originally wanted
// (for example an invite link). The wanted path is kept in a short-lived,
// httpOnly cookie set by proxy.ts, not in the URL, so it survives the email
// round trip without needing extra Supabase redirect-URL entries.

export const POST_LOGIN_COOKIE = "post_login_next";

/** Returns the path if it is a safe same-site path, otherwise null. */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}
