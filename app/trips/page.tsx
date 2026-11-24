import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, Muted, Shell, primaryButton } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Your trips · Group Trip Planner" };

async function TripList() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: trips, error } = await supabase
    .from("trips")
    .select("id, name, destination")
    .order("created_at", { ascending: false });
  // A failed read shows the error screen, never "no trips".
  if (error) throw new Error("Could not load your trips");

  if (!trips || trips.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="font-medium text-zinc-950 dark:text-zinc-50">No trips yet</p>
        <Muted>
          Start one and invite your friends, or open an invite link someone sent you.
        </Muted>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
      {trips.map((trip) => (
        <li key={trip.id}>
          <Link
            href={`/trips/${trip.id}`}
            className="flex flex-col gap-0.5 py-3 hover:underline"
          >
            <span className="font-medium text-zinc-950 dark:text-zinc-50">
              {trip.name}
            </span>
            {trip.destination && (
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {trip.destination}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function TripsPage() {
  return (
    <Shell>
      <div className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          Your trips
        </h1>
        <Link href="/trips/new" className={primaryButton}>
          Start a trip
        </Link>
      </div>
      <Card>
        <Suspense fallback={<Muted>Loading…</Muted>}>
          <TripList />
        </Suspense>
      </Card>
      <Link href="/account" className="text-sm text-zinc-600 underline dark:text-zinc-400">
        Account &amp; sign out
      </Link>
    </Shell>
  );
}
