import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Account · Group Trip Planner" };

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

async function AccountDetails() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <>
      <p className="text-lg text-zinc-700 dark:text-zinc-300">
        Signed in as <strong>{user.email}</strong>
      </p>
      <Link
        href="/trips"
        className="text-base text-zinc-700 underline dark:text-zinc-300"
      >
        Go to your trips
      </Link>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded-full border border-zinc-300 px-6 py-2 text-base font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
        >
          Sign out
        </button>
      </form>
    </>
  );
}

export default function AccountPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-6 py-24 text-center dark:bg-black">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
        Your account
      </h1>
      <Suspense fallback={<p className="text-zinc-500">Loading…</p>}>
        <AccountDetails />
      </Suspense>
    </main>
  );
}
