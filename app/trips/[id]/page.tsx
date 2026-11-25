import { Suspense } from "react";
import Link from "next/link";
import { MemberStack } from "@/components/member-avatar";
import { Card, Muted, Shell, primaryButton, smallPrimaryButton } from "@/components/ui";
import { TripMap } from "@/components/trip-map";
import {
  RSVP_LABELS,
  computeNextStep,
  decidedText,
  decisionState,
  rsvpCounts,
  summarizePoll,
  type PollKind,
} from "@/lib/decide";
import { toMapPlaces } from "@/lib/map-config";
import { formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { loadTripContext, type TripContext } from "@/lib/trip-data";

const TABS = [
  { key: "decide", label: "Decide" },
  { key: "shape", label: "Shape" },
  { key: "book", label: "Book" },
  { key: "prepare", label: "Prepare" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function tabFrom(value: string | string[] | undefined): TabKey {
  return TABS.some((t) => t.key === value) ? (value as TabKey) : "decide";
}

function targetHref(tripId: string, target: string): string {
  if (target.startsWith("?")) return `/trips/${tripId}${target}`;
  return `/trips/${tripId}/${target}`;
}

function NextStepCard({ ctx }: { ctx: TripContext }) {
  const step = computeNextStep({
    meId: ctx.userId,
    members: ctx.members,
    trip: ctx.trip,
    polls: ctx.polls,
    myCardAnswered: ctx.myCardAnswered,
    myBudgetSubmitted: ctx.myBudgetSubmitted,
    budget: ctx.budget,
    hasPlanningBounds: ctx.trip.planningMin !== null,
    myUnvotedStops: ctx.stops.myUnvoted,
    nudges: ctx.nudgesToMe,
  });
  return (
    <section
      aria-labelledby="next-step-title"
      className="flex flex-col gap-3 rounded-xl border-2 border-zinc-900 bg-white p-6 dark:border-zinc-100 dark:bg-zinc-950 max-md:p-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Next step</p>
      <h2 id="next-step-title" className="text-xl font-semibold text-zinc-950 dark:text-zinc-50">
        {step.title}
      </h2>
      {step.nudgedBy && (
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {step.nudgedBy} asked you about this.
        </p>
      )}
      <Muted>{step.detail}</Muted>
      <div>
        <Link href={targetHref(ctx.trip.id, step.target)} className={primaryButton}>
          {step.cta}
        </Link>
      </div>
    </section>
  );
}

function decisionLine(ctx: TripContext, kind: PollKind): string {
  const poll = ctx.polls[kind];
  const state = decisionState(kind, ctx.trip, poll);
  if (state === "decided") return decidedText(kind, ctx.trip) ?? "Decided";
  if (state === "empty" || !poll) return "Nothing suggested yet";
  const summary = summarizePoll(poll, ctx.members);
  return `Voting: ${poll.options.length} option${poll.options.length === 1 ? "" : "s"}, ${summary.votedIds.length} of ${ctx.members.length} voted`;
}

function budgetLine(ctx: TripContext): string {
  const b = ctx.budget;
  if (b.status === "band") {
    return `Comfort zone ${formatMoney(b.low_minor, b.currency)} – ${formatMoney(b.high_minor, b.currency)} per person (${b.respondents} answers)`;
  }
  if (b.status === "no_overlap") return `No shared range yet (${b.respondents} answers)`;
  const bounds =
    ctx.trip.planningMin !== null && ctx.trip.planningMax !== null
      ? ` · agreed bounds ${formatMoney(ctx.trip.planningMin, ctx.trip.currency)} – ${formatMoney(ctx.trip.planningMax, ctx.trip.currency)}`
      : "";
  return `${b.respondents} of ${b.needed} private answers${bounds}`;
}

function DecideTab({ ctx }: { ctx: TripContext }) {
  const counts = rsvpCounts(ctx.members);
  const rows = [
    {
      label: "Who's coming",
      value: `${counts.in} in · ${counts.maybe} maybe · ${counts.not_yet} not yet`,
      href: "decide#who",
    },
    { label: "Dates", value: decisionLine(ctx, "dates"), href: "decide#dates" },
    { label: "Budget", value: budgetLine(ctx), href: "budget" },
    { label: "Destination", value: decisionLine(ctx, "destination"), href: "decide#destination" },
    {
      label: "Preference cards",
      value: `${ctx.cardsAnswered} of ${ctx.members.length} filled in (answers stay private)`,
      href: "preferences",
    },
  ];
  return (
    <Card>
      <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((row) => (
          <li key={row.label}>
            <Link
              href={targetHref(ctx.trip.id, row.href)}
              className="flex min-h-11 items-center justify-between gap-4 py-3 hover:underline"
            >
              <span className="flex flex-col">
                <span className="font-medium text-zinc-950 dark:text-zinc-50">{row.label}</span>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">{row.value}</span>
              </span>
              <span aria-hidden="true" className="text-zinc-400">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Link href={`/trips/${ctx.trip.id}/decide`} className={smallPrimaryButton}>
          Open Decide
        </Link>
        <span className="text-sm text-zinc-500">Your RSVP: {RSVP_LABELS[ctx.me.rsvp]}</span>
      </div>
    </Card>
  );
}

async function ShapeTab({ tripId, ctx }: { tripId: string; ctx: TripContext }) {
  const supabase = await createClient();
  const [stays, items] = await Promise.all([
    supabase.from("stay_quotes").select("id, name, url:source_url, latitude, longitude").eq("trip_id", tripId),
    supabase
      .from("itinerary_items")
      .select("id, title, place_url, day_number, time, latitude, longitude")
      .eq("trip_id", tripId)
      .order("day_number")
      .order("time"),
  ]);
  if (stays.error || items.error) throw new Error("Could not load the map");
  const places = toMapPlaces(stays.data ?? [], items.data ?? []);
  return (
    <>
      <Card title="Map">
        <TripMap places={places} />
      </Card>
      <Card title="Itinerary">
        <div className="flex flex-col gap-3">
          <Muted>
            {ctx.stops.total === 0
              ? "No stops yet. Add places day by day; everyone votes on each one."
              : `${ctx.stops.total} stop${ctx.stops.total === 1 ? "" : "s"}, ${ctx.stops.agreed} agreed by everyone. ${ctx.stops.myUnvoted > 0 ? `${ctx.stops.myUnvoted} waiting for your vote.` : "You've voted on all of them."}`}
          </Muted>
          <div className="flex flex-wrap gap-3">
            <Link href={`/trips/${tripId}/itinerary`} className={smallPrimaryButton}>
              Open itinerary
            </Link>
            <Link href={`/trips/${tripId}/places`} className={smallPrimaryButton}>
              Saved places
            </Link>
            <Link href={`/trips/${tripId}/plans`} className={smallPrimaryButton}>
              Tight / Balanced / Splurge
            </Link>
          </div>
        </div>
      </Card>
    </>
  );
}

function BookTab({ tripId }: { tripId: string }) {
  return (
    <Card title="Stays">
      <div className="flex flex-col gap-3">
        <Muted>Add real stay quotes and compare them per person. Nothing here books anything.</Muted>
        <div>
          <Link href={`/trips/${tripId}/stays`} className={smallPrimaryButton}>
            Compare stay quotes
          </Link>
        </div>
      </div>
    </Card>
  );
}

function PrepareTab() {
  return (
    <Card title="Prepare">
      <Muted>
        Expense split setup, packing checklist and offline downloads are not built yet. Nothing
        here is saved or shared.
      </Muted>
    </Card>
  );
}

async function TripHome({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const ctx = await loadTripContext(id);
  const tab = tabFrom(query.tab);
  const when = decidedText("dates", ctx.trip);
  const where = decidedText("destination", ctx.trip);

  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          {ctx.trip.name}
        </h1>
        <Muted>
          {where || when
            ? [where, when].filter(Boolean).join(" · ")
            : "Where and when are still to be decided"}
        </Muted>
        <MemberStack members={ctx.members} />
      </header>

      <NextStepCard ctx={ctx} />

      <nav aria-label="Planning stages">
        <ul className="grid grid-cols-4 gap-1 rounded-full bg-zinc-100 p-1 dark:bg-zinc-900">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={`/trips/${id}?tab=${t.key}`}
                aria-current={tab === t.key ? "page" : undefined}
                className={`flex min-h-11 items-center justify-center rounded-full px-2 text-sm font-medium ${
                  tab === t.key
                    ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                    : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
                }`}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "decide" && <DecideTab ctx={ctx} />}
      {tab === "shape" && (
        <Suspense fallback={<Muted>Loading map…</Muted>}>
          <ShapeTab tripId={id} ctx={ctx} />
        </Suspense>
      )}
      {tab === "book" && <BookTab tripId={id} />}
      {tab === "prepare" && <PrepareTab />}
    </>
  );
}

export default function TripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Shell>
      <Link href="/trips" className="text-sm text-zinc-600 underline dark:text-zinc-400">
        ← Your trips
      </Link>
      <Suspense
        fallback={
          <div className="flex flex-col gap-6" aria-busy="true">
            <p className="text-zinc-500">Loading trip…</p>
            <div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
          </div>
        }
      >
        <TripHome params={params} searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
