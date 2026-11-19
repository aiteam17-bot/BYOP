import { NextResponse, type NextRequest } from "next/server";
import { POST_LOGIN_COOKIE, safeNextPath } from "@/lib/auth-redirect";
import { createClient } from "@/lib/supabase/server";

// The magic link in the email points here with a one-time ?code=...
// We swap it for a session cookie, then send the user to the page they were
// trying to reach (e.g. an invite link), or to their trips.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const next =
        safeNextPath(request.cookies.get(POST_LOGIN_COOKIE)?.value) ?? "/trips";
      const response = NextResponse.redirect(`${origin}${next}`);
      response.cookies.delete(POST_LOGIN_COOKIE);
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link`);
}
