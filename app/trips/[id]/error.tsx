"use client";

import Link from "next/link";
import { Shell, primaryButton } from "@/components/ui";

// Shown when loading a trip screen fails (network, database). A failed load
// is never shown as an empty trip.
export default function TripError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Shell>
      <div role="alert" className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          We couldn&apos;t load this trip
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Check your connection and try again. Nothing you saved has been lost.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => retry()} className={primaryButton}>
            Try again
          </button>
          <Link href="/trips" className="self-center text-sm text-zinc-600 underline dark:text-zinc-400">
            Back to your trips
          </Link>
        </div>
      </div>
    </Shell>
  );
}
