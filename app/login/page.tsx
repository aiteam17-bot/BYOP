import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Group Trip Planner" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-24 dark:bg-black">
      <div className="flex w-full max-w-sm flex-col gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          Sign in
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Sign in with your GitHub account, or get a one-time link by email.
        </p>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
