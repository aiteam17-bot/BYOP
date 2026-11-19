import type { ReactNode } from "react";

// Plain, shared building blocks. Designed for laptop widths first; the
// `max-md:` classes then adapt the same layout to phones.

export function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-12 max-md:gap-6 max-md:px-4 max-md:py-6">
      {children}
    </main>
  );
}

export function Card({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950 max-md:p-4">
      {title && (
        <h2 className="mb-4 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export const primaryButton =
  "inline-flex items-center justify-center rounded-full bg-zinc-950 px-6 py-2.5 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 max-md:w-full";

export const secondaryButton =
  "inline-flex items-center justify-center rounded-full border border-zinc-300 px-6 py-2.5 text-base font-medium text-zinc-900 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900 max-md:w-full";

export const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base text-zinc-950 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

export const labelClass =
  "flex flex-col gap-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200";

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return (
    <p className="text-base text-zinc-600 dark:text-zinc-400">{children}</p>
  );
}
