import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, Muted, Shell } from "@/components/ui";
import { formatDate, formatKm, formatRupees } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  compareStays,
  nightsBetween,
  type Cancellation,
  type Stay,
} from "@/lib/stay-costs";
import { isUuid } from "@/lib/validation";
import { removeStay } from "./actions";
import { DatesForm } from "./dates-form";
import { StayCard, type StayCardData } from "./stay-card";
import { StayForm } from "./stay-form";

export const metadata = { title: "Compare stays · Group Trip Planner" };

type StayRow = {
  id: string;
  name: string;
  url: string | null;
  nightly_price_paise: number | null;
  taxes_paise: number | null;
  fees_paise: number | null;
  cancellation_type: Cancellation;
  cancellation_terms: string | null;
  rooms: number | null;
  beds: number | null;
  distance_km: number | string | null;
  price_checked_on: string | null;
  added_by: string | null;
};

async function StayComparison({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: trip } = await supabase
    .from("trips")
    .select("id, name, start_date, end_date, owner_id")
    .eq("id", id)
    .maybeSingle();
  if (!trip) notFound();

  const { count } = await supabase
    .from("trip_members")
    .select("user_id", { count: "exact", head: true })
    .eq("trip_id", id);
  const sharers = Math.max(count ?? 1, 1);

  const { data: rows } = await supabase
    .from("stays")
    .select(
      "id, name, url, nightly_price_paise, taxes_paise, fees_paise, cancellation_type, cancellation_terms, rooms, beds, distance_km, price_checked_on, added_by",
    )
    .eq("trip_id", id);
  const stayRows = (rows ?? []) as StayRow[];

  const today = new Date().toISOString().slice(0, 10);
  const nights =
    trip.start_date && trip.end_date
      ? nightsBetween(trip.start_date, trip.end_date)
      : null;
  const hasDates = nights !== null && nights >= 1;
  const isOrganiser = trip.owner_id === user.id;

  // Rows come from the database as paise integers; km becomes hundredths of a
  // km (an integer) so no decimal maths ever happens.
  const stays: Stay[] = stayRows.map((r) => ({
    id: r.id,
    name: r.name,
    nightlyPaise: r.nightly_price_paise ?? 0,
    taxesPaise: r.taxes_paise ?? 0,
    feesPaise: r.fees_paise ?? 0,
    rooms: r.rooms ?? 1,
    beds: r.beds ?? 1,
    distanceCentiKm:
      r.distance_km === null ? null : Math.round(Number(r.distance_km) * 100),
    cancellationType: r.cancellation_type,
  }));

  const compared = compareStays(
    stays,
    hasDates ? nights : null,
    sharers,
    formatRupees,
    formatKm,
  );
  const byId = new Map(stayRows.map((r) => [r.id, r]));
  const cards: StayCardData[] = compared.map((c) => {
    const row = byId.get(c.stay.id)!;
    return {
      ...c,
      url: row.url ?? "",
      cancellationTerms: row.cancellation_terms,
      priceCheckedOn: row.price_checked_on ?? today,
      addedByMe: row.added_by === user.id,
    };
  });

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          Compare stays
        </h1>
        <Muted>
          {trip.name}
          {hasDates &&
            ` · ${formatDate(trip.start_date!)} to ${formatDate(trip.end_date!)} · ${nights} ${nights === 1 ? "night" : "nights"}`}
          {` · ${sharers} ${sharers === 1 ? "person" : "people"} sharing`}
        </Muted>
      </div>

      {!hasDates && (
        <Card title="Set the trip dates">
          {isOrganiser ? (
            <div className="flex flex-col gap-4">
              <Muted>
                We need the number of nights to work out each stay&apos;s true
                cost per person.
              </Muted>
              <DatesForm tripId={id} start={null} end={null} />
            </div>
          ) : (
            <Muted>
              Ask the organiser to set the trip dates. Once they do, each stay
              shows its true cost per person.
            </Muted>
          )}
        </Card>
      )}

      <details
        open={cards.length === 0}
        className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950 max-md:p-4"
      >
        <summary className="cursor-pointer text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          Add a stay
        </summary>
        <div className="mt-5">
          <StayForm tripId={id} today={today} />
        </div>
      </details>

      {cards.length === 0 ? (
        <Muted>No stays yet. Paste the first one above.</Muted>
      ) : (
        <div className="flex flex-col gap-6">
          <Muted>
            Sorted by true cost per person, cheapest first.
            {hasDates && " Per-person costs are rounded up to the next paisa."}
          </Muted>
          {cards.map((card, index) => (
            <StayCard
              key={card.stay.id}
              data={card}
              today={today}
              rank={index + 1}
              sharers={sharers}
              removeAction={removeStay.bind(null, id, card.stay.id)}
            />
          ))}
        </div>
      )}

      {hasDates && isOrganiser && (
        <details className="text-sm text-zinc-600 dark:text-zinc-400">
          <summary className="cursor-pointer underline">Change trip dates</summary>
          <div className="mt-4 max-w-xl">
            <DatesForm
              tripId={id}
              start={trip.start_date}
              end={trip.end_date}
            />
          </div>
        </details>
      )}
    </>
  );
}

export default function StaysPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Shell>
      <Suspense fallback={<Muted>Loading stays…</Muted>}>
        <StayComparisonWithBack params={params} />
      </Suspense>
    </Shell>
  );
}

// The back link needs the trip id, which is part of the request params.
async function StayComparisonWithBack({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <Link
        href={`/trips/${id}`}
        className="text-sm text-zinc-600 underline dark:text-zinc-400"
      >
        ← Back to the trip
      </Link>
      <StayComparison params={params} />
    </>
  );
}
