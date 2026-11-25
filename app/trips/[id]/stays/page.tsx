import { Suspense } from "react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ClientKey } from "@/components/client-key";
import { LiveStatus, LiveTrip } from "@/components/live-trip";
import { TripMap } from "@/components/trip-map";
import { Card, Muted, Shell, inputClass, labelClass, smallButton, smallPrimaryButton } from "@/components/ui";
import { canPlan } from "@/lib/decide";
import { tripDays } from "@/lib/itinerary";
import { CURRENCIES, COMMON_TIMEZONES, formatMoney } from "@/lib/money";
import { compareQuotes, quotedTotalMinor, type ComparedQuote, type Quote } from "@/lib/quotes";
import { createClient } from "@/lib/supabase/server";
import { loadTripContext, type TripContext } from "@/lib/trip-data";
import { safeHttpUrl } from "@/lib/url";
import { paiseToRupeesString } from "@/lib/validation";
import { formatInZone, isoToZonedLocal } from "@/lib/zoned";
import { DatesForm } from "./dates-form";
import { createQuote, deleteQuote, updateQuote, voteQuote } from "./quote-actions";

export const metadata = { title: "Compare stays · Group Trip Planner" };

type Row = {
  id: string;
  name: string;
  source_url: string;
  pricing_basis: Quote["pricingBasis"];
  currency: string;
  quoted_amount_minor: number | string;
  nights: number;
  rooms: number;
  taxes_minor: number | string | null;
  fees_minor: number | string | null;
  sharers: number;
  beds: number | null;
  fx_rate_micros: number | string | null;
  fx_rate_date: string | null;
  fx_source: string | null;
  cancellation_deadline: string | null;
  cancellation_tz: string | null;
  cancellation_terms: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  transport_estimate_per_person_minor: number | string | null;
  checked_at: string;
  created_by: string | null;
  version: number;
};

const num = (v: number | string | null) => (v === null ? null : Number(v));

function toQuote(r: Row): Quote {
  return {
    id: r.id,
    name: r.name,
    pricingBasis: r.pricing_basis,
    currency: r.currency,
    quotedAmountMinor: Number(r.quoted_amount_minor),
    nights: r.nights,
    rooms: r.rooms,
    taxesMinor: num(r.taxes_minor),
    feesMinor: num(r.fees_minor),
    sharers: r.sharers,
    fxRateMicros: num(r.fx_rate_micros),
    fxRateDate: r.fx_rate_date,
    fxSource: r.fx_source,
    transportEstimatePerPersonMinor: num(r.transport_estimate_per_person_minor),
  };
}

function QuoteFields({ ctx, row, defaultNights }: { ctx: TripContext; row?: Row; defaultNights: number | null }) {
  const tz = ctx.trip.timezone;
  const zones = [...new Set([tz, ...COMMON_TIMEZONES])];
  return (
    <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
      <label className={labelClass}>
        Stay name
        <input name="name" required maxLength={120} defaultValue={row?.name} placeholder="Name of the stay" className={inputClass} />
      </label>
      <label className={labelClass}>
        Where the price came from (link)
        <input name="source_url" type="url" required defaultValue={row?.source_url} placeholder="https://…" className={inputClass} />
      </label>
      <fieldset className="col-span-2 flex flex-col gap-2 max-md:col-span-1">
        <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">The price you saw is…</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="pricing_basis" value="per_room_per_night" required defaultChecked={row?.pricing_basis === "per_room_per_night"} />
          per room, per night
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="pricing_basis" value="entire_stay_total" defaultChecked={row?.pricing_basis === "entire_stay_total"} />
          the total for the whole stay (all rooms, all nights)
        </label>
      </fieldset>
      <label className={labelClass}>
        Price as quoted
        <input name="quoted_amount" required inputMode="decimal" defaultValue={paiseToRupeesString(num(row?.quoted_amount_minor ?? null))} placeholder="Amount" className={inputClass} />
      </label>
      <label className={labelClass}>
        Currency of the quote
        <select name="currency" defaultValue={row?.currency ?? ctx.trip.currency} className={inputClass}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Nights
        <input name="nights" required inputMode="numeric" defaultValue={row?.nights ?? defaultNights ?? ""} className={inputClass} />
      </label>
      <label className={labelClass}>
        Rooms
        <input name="rooms" required inputMode="numeric" defaultValue={row?.rooms ?? 1} className={inputClass} />
      </label>
      <label className={labelClass}>
        Taxes, total (blank = unknown)
        <input name="taxes" inputMode="decimal" defaultValue={paiseToRupeesString(num(row?.taxes_minor ?? null))} placeholder="Unknown" className={inputClass} />
      </label>
      <label className={labelClass}>
        Fees, total (blank = unknown)
        <input name="fees" inputMode="decimal" defaultValue={paiseToRupeesString(num(row?.fees_minor ?? null))} placeholder="Unknown" className={inputClass} />
      </label>
      <label className={labelClass}>
        People sharing the cost
        <input name="sharers" required inputMode="numeric" defaultValue={row?.sharers ?? ctx.members.length} className={inputClass} />
      </label>
      <label className={labelClass}>
        Beds (optional)
        <input name="beds" inputMode="numeric" defaultValue={row?.beds ?? ""} className={inputClass} />
      </label>
      <label className={labelClass}>
        Price checked at ({tz.replace(/_/g, " ")} time)
        <input name="checked_at" type="datetime-local" required defaultValue={row ? isoToZonedLocal(row.checked_at, tz) : ""} className={inputClass} />
      </label>
      <label className={labelClass}>
        Map location (optional)
        <input
          name="coordinates"
          placeholder="latitude, longitude"
          defaultValue={row?.latitude !== null && row?.latitude !== undefined ? `${Number(row.latitude)}, ${Number(row.longitude)}` : ""}
          className={inputClass}
        />
      </label>
      <fieldset className="col-span-2 grid grid-cols-3 gap-4 max-md:col-span-1 max-md:grid-cols-1">
        <legend className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Only if the quote is not in {ctx.trip.currency}: the rate you used
        </legend>
        <label className={labelClass}>
          {ctx.trip.currency} per 1 unit
          <input name="fx_rate" inputMode="decimal" defaultValue={row?.fx_rate_micros ? String(Number(row.fx_rate_micros) / 1_000_000) : ""} className={inputClass} />
        </label>
        <label className={labelClass}>
          Rate date
          <input name="fx_rate_date" type="date" defaultValue={row?.fx_rate_date ?? ""} className={inputClass} />
        </label>
        <label className={labelClass}>
          Rate source
          <input name="fx_source" maxLength={120} defaultValue={row?.fx_source ?? ""} placeholder="e.g. bank's rate" className={inputClass} />
        </label>
      </fieldset>
      <label className={labelClass}>
        Free cancellation until (optional)
        <input
          name="cancellation_deadline"
          type="datetime-local"
          defaultValue={row?.cancellation_deadline && row.cancellation_tz ? isoToZonedLocal(row.cancellation_deadline, row.cancellation_tz) : ""}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        …in this time zone
        <select name="cancellation_tz" defaultValue={row?.cancellation_tz ?? tz} className={inputClass}>
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>
      <label className={`${labelClass} col-span-2 max-md:col-span-1`}>
        Cancellation terms (optional)
        <input name="cancellation_terms" maxLength={1000} defaultValue={row?.cancellation_terms ?? ""} className={inputClass} />
      </label>
      <label className={`${labelClass} col-span-2 max-md:col-span-1`}>
        Local transport per person, your estimate in {ctx.trip.currency} (optional, kept separate)
        <input name="transport_estimate" inputMode="decimal" defaultValue={paiseToRupeesString(num(row?.transport_estimate_per_person_minor ?? null))} placeholder="Unknown" className={inputClass} />
      </label>
    </div>
  );
}

function QuoteCard({
  ctx,
  c,
  row,
  rank,
  votes,
  defaultNights,
}: {
  ctx: TripContext;
  c: ComparedQuote;
  row: Row;
  rank: number | null;
  votes: Record<string, "for" | "against">;
  defaultNights: number | null;
}) {
  const q = c.quote;
  const qm = (minor: number) => formatMoney(minor, q.currency);
  const tm = (minor: number) => formatMoney(minor, ctx.trip.currency);
  const link = safeHttpUrl(row.source_url);
  const canEdit = row.created_by === ctx.userId || canPlan(ctx.me.role);
  const mine = votes[ctx.userId];
  const nameOf = (id: string) => ctx.members.find((m) => m.userId === id)?.name ?? "Former member";
  const forIds = ctx.members.filter((m) => votes[m.userId] === "for").map((m) => m.userId);
  const againstIds = ctx.members.filter((m) => votes[m.userId] === "against").map((m) => m.userId);
  const atLeast = c.total.unknown.length > 0;
  const split = c.perPerson;

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">
          {rank !== null && <span className="mr-2 text-zinc-400">{rank}.</span>}
          {q.name}
        </h3>
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="text-sm text-blue-700 underline dark:text-blue-400">
            Source ↗
          </a>
        )}
      </div>

      <div className="flex flex-col gap-1 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
        <p>
          {q.pricingBasis === "per_room_per_night"
            ? `${qm(q.quotedAmountMinor)} per room per night × ${q.rooms} room${q.rooms === 1 ? "" : "s"} × ${q.nights} night${q.nights === 1 ? "" : "s"} = ${qm(quotedTotalMinor(q))}`
            : `${qm(q.quotedAmountMinor)} for the whole stay, as quoted (${q.rooms} room${q.rooms === 1 ? "" : "s"}, ${q.nights} night${q.nights === 1 ? "" : "s"}; not multiplied again)`}
        </p>
        <p>Taxes: {q.taxesMinor === null ? "Unknown" : qm(q.taxesMinor)} · Fees: {q.feesMinor === null ? "Unknown" : qm(q.feesMinor)}</p>
        <p className="font-medium">
          Total: {atLeast ? "at least " : ""}
          {qm(c.total.amountMinor)}
          {atLeast && ` (${c.total.unknown.join(" and ")} unknown)`}
        </p>
        {c.converted && c.tripTotalMinor !== null && (
          <p>
            = {atLeast ? "at least " : ""}
            {tm(c.tripTotalMinor)} at {Number(q.fxRateMicros) / 1_000_000} {ctx.trip.currency} per {q.currency} ({q.fxSource}, rate dated {q.fxRateDate})
          </p>
        )}
        {c.tripTotalMinor === null && (
          <p className="font-medium text-amber-800 dark:text-amber-300">
            In {q.currency} with no recorded rate, so it is not compared or ranked. Edit it to add the rate, its date and source.
          </p>
        )}
      </div>

      {split && (
        <div>
          <p className="text-sm text-zinc-500">Per person ({q.sharers} sharing)</p>
          <p className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            {atLeast ? "at least " : ""}
            {tm(split.baseMinor)}
          </p>
          {split.extraCount > 0 && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {split.extraCount} of {q.sharers} pay {tm(split.baseMinor + 1)} so the shares add up exactly to {tm(c.tripTotalMinor!)}.
            </p>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
        {c.nightsMismatch && (
          <li className="font-medium text-amber-800 dark:text-amber-300">
            Quoted for {q.nights} night{q.nights === 1 ? "" : "s"}; the trip dates cover {defaultNights}.
          </li>
        )}
        {q.transportEstimatePerPersonMinor !== null && (
          <li>Local transport: about {tm(q.transportEstimatePerPersonMinor)} per person (a member&apos;s estimate, not included above)</li>
        )}
        {row.cancellation_deadline && row.cancellation_tz ? (
          <li>Free cancellation until {formatInZone(row.cancellation_deadline, row.cancellation_tz)}</li>
        ) : (
          <li>Cancellation deadline not recorded</li>
        )}
        {row.cancellation_terms && <li>{row.cancellation_terms}</li>}
        {row.beds !== null && <li>{row.beds} beds</li>}
        <li>
          Price checked {formatInZone(row.checked_at, ctx.trip.timezone)}. Prices change: this is not a live price.
        </li>
      </ul>

      <div className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {forIds.length > 0 && <>For: {forIds.map(nameOf).join(", ")}. </>}
          {againstIds.length > 0 && <>Against: {againstIds.map(nameOf).join(", ")}. </>}
          Voting shows preference only. It does not book or hold anything.
        </p>
        <ActionForm action={voteQuote.bind(null, ctx.trip.id, q.id)} className="flex flex-wrap gap-2" ariaLabel={`Your vote on ${q.name}`}>
          <SubmitButton name="vote" value="for" pressed={mine === "for"} className={mine === "for" ? smallPrimaryButton : smallButton}>
            For
          </SubmitButton>
          <SubmitButton name="vote" value="against" pressed={mine === "against"} className={mine === "against" ? smallPrimaryButton : smallButton}>
            Against
          </SubmitButton>
          {mine && (
            <SubmitButton name="vote" value="clear" className={smallButton}>
              Withdraw my vote
            </SubmitButton>
          )}
        </ActionForm>
      </div>

      {canEdit && (
        <div className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <details>
            <summary className="cursor-pointer text-sm underline">Edit this quote</summary>
            <ActionForm
              action={updateQuote.bind(null, ctx.trip.id, q.id, ctx.trip.currency, ctx.trip.timezone)}
              className="mt-3 flex flex-col gap-4"
              ariaLabel={`Edit ${q.name}`}
            >
              <input type="hidden" name="expected_version" value={row.version} />
              <QuoteFields ctx={ctx} row={row} defaultNights={defaultNights} />
              <p className="text-sm text-zinc-500">
                If someone else saved a change first, yours is not applied and you&apos;ll see theirs. Editing restarts the votes.
              </p>
              <div>
                <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
                  Save
                </SubmitButton>
              </div>
            </ActionForm>
          </details>
          <details>
            <summary className="cursor-pointer text-sm text-red-700 underline dark:text-red-400">Delete this quote</summary>
            <ActionForm action={deleteQuote.bind(null, ctx.trip.id, q.id, row.version)} className="mt-2">
              <SubmitButton className={smallButton} pendingText="Deleting…">
                Yes, delete
              </SubmitButton>
            </ActionForm>
          </details>
        </div>
      )}
    </li>
  );
}

async function Stays({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadTripContext(id);
  const supabase = await createClient();
  const [quotesRes, votesRes, legacyRes] = await Promise.all([
    supabase
      .from("stay_quotes")
      .select(
        "id, name, source_url, pricing_basis, currency, quoted_amount_minor, nights, rooms, taxes_minor, fees_minor, sharers, beds, fx_rate_micros, fx_rate_date, fx_source, cancellation_deadline, cancellation_tz, cancellation_terms, latitude, longitude, transport_estimate_per_person_minor, checked_at, created_by, version",
      )
      .eq("trip_id", id),
    supabase.from("stay_quote_votes").select("quote_id, user_id, vote").eq("trip_id", id),
    supabase.from("stays").select("id, name").eq("trip_id", id),
  ]);
  if (quotesRes.error || votesRes.error || legacyRes.error) throw new Error("Could not load stays");
  const rows = (quotesRes.data ?? []) as Row[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const days = tripDays(ctx.trip.startDate, ctx.trip.endDate);
  const tripNights = days === null ? null : days - 1;
  const compared = compareQuotes(rows.map(toQuote), ctx.trip.currency, tripNights);
  const votesByQuote: Record<string, Record<string, "for" | "against">> = {};
  for (const v of votesRes.data ?? []) (votesByQuote[v.quote_id] ??= {})[v.user_id] = v.vote as "for" | "against";
  let rank = 0;

  const mapPlaces = rows.map((r) => ({
    id: `quote-${r.id}`,
    kind: "stay" as const,
    name: r.name,
    detail: "Stay quote",
    url: safeHttpUrl(r.source_url),
    lat: num(r.latitude),
    lng: num(r.longitude),
  }));

  return (
    <LiveTrip tripId={id} userId={ctx.userId} displayName={ctx.me.name}>
      <div className="flex flex-col gap-1">
        <Link href={`/trips/${id}?tab=book`} className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← {ctx.trip.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">Compare stays</h1>
        <Muted>
          Real quotes members found, compared per person in {ctx.trip.currency}
          {tripNights !== null && ` for ${tripNights} night${tripNights === 1 ? "" : "s"}`}. Nothing here books or refreshes a price.
        </Muted>
        <LiveStatus />
      </div>

      {tripNights === null && ctx.me.role === "owner" && (
        <Card title="Set the trip dates">
          <div className="flex flex-col gap-3">
            <Muted>With dates, quotes for a different number of nights are flagged.</Muted>
            <DatesForm tripId={id} start={null} end={null} />
          </div>
        </Card>
      )}

      <details open={rows.length === 0} className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950 max-md:p-4">
        <summary className="cursor-pointer text-lg font-semibold text-zinc-950 dark:text-zinc-50">Add a quote</summary>
        <ActionForm
          action={createQuote.bind(null, id, ctx.trip.currency, ctx.trip.timezone)}
          className="mt-4 flex flex-col gap-4"
          ariaLabel="Add a quote"
        >
          <ClientKey />
          <QuoteFields ctx={ctx} defaultNights={tripNights} />
          <div>
            <SubmitButton className={smallPrimaryButton} pendingText="Adding…">
              Add quote
            </SubmitButton>
          </div>
        </ActionForm>
      </details>

      {compared.length === 0 ? (
        <Card>
          <Muted>No quotes yet. Paste the first real one above.</Muted>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Stay quotes, cheapest per person first">
          {compared.map((c) => (
            <QuoteCard
              key={c.quote.id}
              ctx={ctx}
              c={c}
              row={byId.get(c.quote.id)!}
              rank={c.perPerson ? ++rank : null}
              votes={votesByQuote[c.quote.id] ?? {}}
              defaultNights={tripNights}
            />
          ))}
        </ul>
      )}

      {(legacyRes.data ?? []).length > 0 && (
        <Card title="Earlier stays (old format)">
          <Muted>
            These were added before quotes recorded the pricing basis, so they are not compared. Re-add them as quotes:{" "}
            {(legacyRes.data ?? []).map((s) => s.name).join(", ")}.
          </Muted>
        </Card>
      )}

      <Card title="Map of stays">
        <TripMap places={mapPlaces} />
      </Card>
    </LiveTrip>
  );
}

export default function StaysPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Shell>
      <Suspense fallback={<Muted>Loading stays…</Muted>}>
        <Stays params={params} />
      </Suspense>
    </Shell>
  );
}
