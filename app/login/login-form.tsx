"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

export function LoginForm() {
  const searchParams = useSearchParams();
  const linkFailed = searchParams.get("error") === "link";

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [githubStatus, setGithubStatus] = useState<Status>({ kind: "idle" });

  // GitHub OAuth: Supabase sends the browser to GitHub, GitHub sends it back to
  // Supabase, and Supabase redirects to /auth/callback with a one-time ?code=.
  // That callback URL must be listed under Supabase > Authentication > URL
  // Configuration > Redirect URLs for every deployed domain.
  async function onGithub() {
    setGithubStatus({ kind: "sending" });
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      // On success the browser is already navigating to GitHub.
    } catch (err) {
      setGithubStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus({ kind: "sending" });

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      setStatus({ kind: "sent" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }

  if (status.kind === "sent") {
    return (
      <p className="text-lg text-zinc-700 dark:text-zinc-300">
        Check your inbox: we sent a sign-in link to <strong>{email}</strong>.
        You can close this tab once you click it.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-4">
      {linkFailed && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Sign-in did not finish (the link or GitHub approval was invalid or
          expired). Please try again.
        </p>
      )}
      <button
        type="button"
        onClick={onGithub}
        disabled={githubStatus.kind === "sending"}
        className="rounded-full bg-zinc-950 px-8 py-3 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
      >
        {githubStatus.kind === "sending" ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
      {githubStatus.kind === "error" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {githubStatus.message}
        </p>
      )}
      <p className="text-sm text-zinc-500 dark:text-zinc-400">or use email</p>
      <label className="flex flex-col gap-2 text-left text-sm font-medium text-zinc-800 dark:text-zinc-200">
        Email address
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-950 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
      </label>
      <button
        type="submit"
        disabled={status.kind === "sending"}
        className="rounded-full border border-zinc-300 px-8 py-3 text-base font-medium text-zinc-900 transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
      >
        {status.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>
      {status.kind === "error" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {status.message}
        </p>
      )}
    </form>
  );
}
