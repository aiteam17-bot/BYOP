"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { primaryButton } from "@/components/ui";

// GitHub is the only sign-in method. Email sign-in links would depend on
// Supabase's default email sender, which is rate limited and not meant for
// real sign-ups, so it is not offered.
export function LoginForm() {
  const searchParams = useSearchParams();
  const failed = searchParams.get("error") !== null;
  const [status, setStatus] = useState<{ kind: "idle" | "opening" } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  // Supabase sends the browser to GitHub, GitHub back to Supabase, and
  // Supabase to /auth/callback with a one-time ?code=. That exact callback URL
  // must be in Supabase > Authentication > URL Configuration > Redirect URLs.
  async function signIn() {
    setStatus({ kind: "opening" });
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      // On success the browser is already on its way to GitHub.
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {failed && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Sign-in did not finish. Please try again.
        </p>
      )}
      <button
        type="button"
        onClick={signIn}
        disabled={status.kind === "opening"}
        className={primaryButton}
      >
        {status.kind === "opening" ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {status.message}
        </p>
      )}
    </div>
  );
}
