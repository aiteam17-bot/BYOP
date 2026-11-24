"use client";

import Link from "next/link";
import { Shell, primaryButton } from "@/components/ui";

// Shown when a screen's data could not be loaded (network or database error).
// A failed load is never shown as an empty list, a blank form or "not found".
export function LoadError({
  title,
  retry,
  backHref = "/trips",
  backLabel = "Back to your trips",
}: {
  title: string;
  retry: () => void;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <Shell>
      <div role="alert" className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{title}</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Check your connection and try again. Nothing you saved has been lost.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => retry()} className={primaryButton}>
            Try again
          </button>
          <Link href={backHref} className="self-center text-sm text-zinc-600 underline dark:text-zinc-400">
            {backLabel}
          </Link>
        </div>
      </div>
    </Shell>
  );
}
