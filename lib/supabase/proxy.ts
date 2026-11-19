import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { POST_LOGIN_COOKIE } from "@/lib/auth-redirect";
import { supabaseAnonKey, supabaseUrl } from "./env";

// Pages that need a signed-in user.
const PRIVATE_PREFIXES = ["/account", "/trips", "/join"];

// Refreshes the Supabase session cookie on each request and sends signed-out
// visitors away from private pages.
export async function updateSession(request: NextRequest) {
  // Not configured yet (e.g. first local run): let the public pages work.
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do not put code between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPrivate = PRIVATE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

  if (!user && isPrivate) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    // Remember where they were heading (e.g. an invite link) for after sign-in.
    redirect.cookies.set(POST_LOGIN_COOKIE, path + request.nextUrl.search, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60,
      path: "/",
    });
    return redirect;
  }

  return response;
}
