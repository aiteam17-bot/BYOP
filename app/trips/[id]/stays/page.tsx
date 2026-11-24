import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, Muted, Shell } from "@/components/ui";
import { formatDate, formatKm } from "@/lib/format";
import { currencySymbol, formatMoney } from "@/lib/money";
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

  const [tripRes, membersRes, staysRes] = await Promise.all([
    supabase
      .from("trips")
      .select("id, name, start_date, end_date, owner_id, currency")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("trip_members")
      .select("user_id", { count: "exact", head: true })
      .eq("trip_id", id),
    supabase
      .from("stays")
      .select(
        "id, name, url, nightly_price_paise, taxes_paise, fees_paise, cancellation_type, cancellation_terms, rooms, beds, distance_km, price_checked_on, added_by",
      )
      .eq("trip_id", id),
  ]);
  // A failed read shows the error screen (with Try again), never an empty or
  // guessed comparison.
  if (tripRes.error || membersRes.error || staysRes.error) {
    throw new Error("Could not load stays");
  }
  const trip = tripRes.data;
  if (!trip) notFound();
  if (!membersRes.count) throw new Error("Could not count the people on this trip");
  const sharers = membersRes.count;

  const allRows = (staysRes.data ?? []) as StayRow[];
  // Stays missing a price, rooms or beds are listed separately and never
  // ranked: no number is invented for them.
  const stayRows = allRows.filter(
    (r) => r.nightly_price_paise !== null && r.rooms !== null && r.beds !== null,
  );
  const incomplete = allRows.filter((r) => !stayRows.includes(r));

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
    nightlyPaise: r.nightly_price_paise!,
    // Taxes and fees are optional in the form: empty means none were charged.
    taxesPaise: r.taxes_paise ?? 0,
    feesPaise: r.fees_paise ?? 0,
    rooms: r.rooms!,
    beds: r.beds!,
    distanceCentiKm:
      r.distance_km === null ? null : Math.round(Number(r.distance_km) * 100),
    cancellationType: r.cancellation_type,
  }));

  const compared = compareStays(
    stays,
    hasDates ? nights : null,
    sharers,
    (minor: number) => formatMoney(minor, trip.currency),
    formatKm,
  );
  const byId = new Map(stayRows.map((r) => [r.id, r]));
  const cards: StayCardData[] = compared.map((c) => {
    const row = byId.get(c.stay.id)!;
    return {
      ...c,
      url: row.url ?? "",
      cancellationTerms: row.cancellation_terms,
      priceCheckedOn: row.price_checked_on,
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
          <StayForm tripId={id} today={today} symbol={currencySymbol(trip.currency)} />
        </div>
      </details>

      {incomplete.length > 0 && (
        <Card title="Missing details">
          <div className="flex flex-col gap-3">
            <Muted>
              These stays are missing a nightly price, rooms or beds, so they
              are not ranked. Whoever added one can remove it and add it again
              with the full details.
            </Muted>
            <ul className="flex flex-col gap-1">
              {incomplete.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-zinc-950 dark:text-zinc-50">{r.name}</span>
                  {r.added_by === user.id && (
                    <form action={removeStay.bind(null, id, r.id)}>
                      <button type="submit" className="text-sm text-zinc-500 underline">
                        Remove this stay
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

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
              currency={trip.currency}
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
