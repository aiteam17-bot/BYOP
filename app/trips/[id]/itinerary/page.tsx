import { Suspense } from "react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ClientKey } from "@/components/client-key";
import { TripMap } from "@/components/trip-map";
import {
  Card,
  Muted,
  Shell,
  inputClass,
  labelClass,
  smallButton,
  smallPrimaryButton,
} from "@/components/ui";
import { canPlan } from "@/lib/decide";
import {
  dayLabel,
  dayWarnings,
  distancesFromPrevious,
  fromMinutes,
  sortStops,
  stopStatus,
  toMinutes,
  tripDays,
  type Stop,
} from "@/lib/itinerary";
import { toMapPlaces } from "@/lib/map-config";
import { currencySymbol, formatMoney } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { loadTripContext, type TripContext } from "@/lib/trip-data";
import { safeHttpUrl } from "@/lib/url";
import { paiseToRupeesString } from "@/lib/validation";
import { addComment, addStop, deleteComment, deleteStop, updateStop, voteStop } from "./actions";

export const metadata = { title: "Itinerary · Group Trip Planner" };

type Vote = "for" | "against";
type Comment = { id: string; item_id: string; user_id: string; body: string; created_at: string };

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];

const STATUS_STYLE: Record<string, string> = {
  agreed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  contested: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  proposed: "border border-dashed border-zinc-400 text-zinc-700 dark:text-zinc-300",
};
const STATUS_LABEL: Record<string, string> = {
  agreed: "Agreed by everyone",
  contested: "Needs a decision",
  proposed: "Proposed",
};

function StopFields({
  ctx,
  maxDay,
  stop,
  day,
}: {
  ctx: TripContext;
  maxDay: number;
  stop?: Stop;
  day: number;
}) {
  const durations = stop && !DURATIONS.includes(stop.duration) ? [stop.duration, ...DURATIONS] : DURATIONS;
  return (
    <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
      <label className={`${labelClass} col-span-2 max-md:col-span-1`}>
        What
        <input name="title" required maxLength={120} defaultValue={stop?.title} placeholder="Name of the place or activity" className={inputClass} />
      </label>
      <label className={labelClass}>
        Day
        <select name="day" defaultValue={stop?.day ?? day} className={inputClass}>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {dayLabel(d, ctx.trip.startDate)}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Starts ({ctx.trip.timezone.replace(/_/g, " ")} time)
        <input name="time" type="time" required defaultValue={stop?.time} className={inputClass} />
      </label>
      <label className={labelClass}>
        How long
        <select name="duration" defaultValue={stop?.duration ?? 60} className={inputClass}>
          {durations.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Indicative cost per person ({currencySymbol(ctx.trip.currency)}, optional)
        <input name="cost" inputMode="decimal" placeholder="Amount" defaultValue={paiseToRupeesString(stop?.costMinor ?? null)} className={inputClass} />
      </label>
      <label className={labelClass}>
        Link (optional)
        <input name="place_url" type="url" placeholder="https://…" defaultValue={stop?.placeUrl ?? ""} className={inputClass} />
      </label>
      <label className={labelClass}>
        Map location (optional)
        <input
          name="coordinates"
          placeholder="latitude, longitude"
          defaultValue={stop?.lat !== null && stop?.lat !== undefined ? `${stop.lat}, ${stop.lng}` : ""}
          className={inputClass}
        />
      </label>
      <label className={`${labelClass} col-span-2 max-md:col-span-1`}>
        Notes (optional)
        <textarea name="notes" maxLength={1000} rows={2} defaultValue={stop?.notes ?? ""} className={inputClass} />
      </label>
    </div>
  );
}

function StopCard({
  ctx,
  stop,
  votes,
  comments,
  distanceKm,
  warning,
  maxDay,
}: {
  ctx: TripContext;
  stop: Stop;
  votes: Record<string, Vote>;
  comments: Comment[];
  distanceKm: number | undefined;
  warning: string | undefined;
  maxDay: number;
}) {
  const memberIds = ctx.members.map((m) => m.userId);
  const status = stopStatus(votes, memberIds);
  const mine = votes[ctx.userId];
  const nameOf = (id: string) => ctx.members.find((m) => m.userId === id)?.name ?? "Former member";
  const canEdit = stop.createdBy === ctx.userId || canPlan(ctx.me.role);
  const link = safeHttpUrl(stop.placeUrl);
  const forIds = memberIds.filter((id) => votes[id] === "for");
  const againstIds = memberIds.filter((id) => votes[id] === "against");
  const waiting = memberIds.filter((id) => !votes[id]);
  const end = fromMinutes(toMinutes(stop.time) + stop.duration);

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          <span className="mr-2 font-normal tabular-nums text-zinc-500">
            {stop.time}–{end}
          </span>
          {stop.title}
        </h3>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>
      </div>
      {warning && (
        <p role="note" className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {warning}
        </p>
      )}
      <ul className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
        {stop.costMinor !== null && <li>About {formatMoney(stop.costMinor, ctx.trip.currency)} per person (entered by a member)</li>}
        {distanceKm !== undefined && <li>{distanceKm.toFixed(1)} km in a straight line from the previous stop (not a route or travel time)</li>}
        {link && (
          <li>
            <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-700 underline dark:text-blue-400">
              Open link ↗
            </a>
          </li>
        )}
        {stop.notes && <li className="whitespace-pre-line">{stop.notes}</li>}
        <li>Added by {stop.createdBy ? nameOf(stop.createdBy) : "someone"}</li>
      </ul>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {forIds.length > 0 && <>For: {forIds.map(nameOf).join(", ")}. </>}
          {againstIds.length > 0 && <>Against: {againstIds.map(nameOf).join(", ")}. </>}
          {waiting.length > 0 && <>Not voted: {waiting.map(nameOf).join(", ")}.</>}
        </p>
        <ActionForm action={voteStop.bind(null, ctx.trip.id, stop.id)} className="flex flex-wrap gap-2" ariaLabel={`Your vote on ${stop.title}`}>
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

      <section aria-label={`Comments on ${stop.title}`} className="flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        {comments.length === 0 ? (
          <p className="text-sm text-zinc-500">No comments yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {comments.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
                <p className="min-w-0 flex-1 whitespace-pre-line text-zinc-800 dark:text-zinc-200">
                  <strong>{nameOf(c.user_id)}:</strong> {c.body}
                </p>
                {(c.user_id === ctx.userId || canPlan(ctx.me.role)) && (
                  <ActionForm action={deleteComment.bind(null, ctx.trip.id, c.id)}>
                    <SubmitButton className="text-sm text-zinc-500 underline" pendingText="Deleting…" ariaLabel="Delete comment">
                      Delete
                    </SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={addComment.bind(null, ctx.trip.id, stop.id)} className="flex gap-2 max-md:flex-col" ariaLabel={`Comment on ${stop.title}`}>
          <ClientKey />
          <label className="sr-only" htmlFor={`comment-${stop.id}`}>
            Comment
          </label>
          <input id={`comment-${stop.id}`} name="body" required maxLength={1000} placeholder="Add a comment" className={inputClass} />
          <SubmitButton className={smallButton} pendingText="Posting…">
            Post
          </SubmitButton>
        </ActionForm>
      </section>

      {canEdit && (
        <div className="flex flex-wrap gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <details className="w-full">
            <summary className="cursor-pointer text-sm text-zinc-700 underline dark:text-zinc-300">Edit or move</summary>
            <div className="mt-3">
              <ActionForm action={updateStop.bind(null, ctx.trip.id, stop.id, maxDay)} className="flex flex-col gap-4" ariaLabel={`Edit ${stop.title}`}>
                <StopFields ctx={ctx} maxDay={maxDay} stop={stop} day={stop.day} />
                <p className="text-sm text-zinc-500">Changing the day, time, length, place or cost restarts everyone&apos;s votes.</p>
                <div>
                  <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
                    Save changes
                  </SubmitButton>
                </div>
              </ActionForm>
            </div>
          </details>
          <details>
            <summary className="cursor-pointer text-sm text-red-700 underline dark:text-red-400">Delete this stop</summary>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Its votes and comments go too.</span>
              <ActionForm action={deleteStop.bind(null, ctx.trip.id, stop.id)}>
                <SubmitButton className={smallButton} pendingText="Deleting…">
                  Yes, delete
                </SubmitButton>
              </ActionForm>
            </div>
          </details>
        </div>
      )}
    </li>
  );
}

async function Itinerary({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const ctx = await loadTripContext(id);
  const supabase = await createClient();
  const [itemsRes, votesRes, commentsRes, staysRes] = await Promise.all([
    supabase
      .from("itinerary_items")
      .select("id, day_number, time, duration_minutes, title, place_url, latitude, longitude, cost_minor, notes, created_by")
      .eq("trip_id", id),
    supabase.from("stop_votes").select("item_id, user_id, vote").eq("trip_id", id),
    supabase.from("stop_comments").select("id, item_id, user_id, body, created_at").eq("trip_id", id).order("created_at"),
    supabase.from("stays").select("id, name, url, latitude, longitude").eq("trip_id", id),
  ]);
  if (itemsRes.error || votesRes.error || commentsRes.error || staysRes.error) {
    throw new Error("Could not load the itinerary");
  }

  const stops: Stop[] = (itemsRes.data ?? []).map((r) => ({
    id: r.id,
    day: r.day_number,
    time: (r.time ?? "00:00").slice(0, 5),
    duration: r.duration_minutes,
    title: r.title,
    placeUrl: r.place_url,
    lat: r.latitude === null ? null : Number(r.latitude),
    lng: r.longitude === null ? null : Number(r.longitude),
    costMinor: r.cost_minor === null ? null : Number(r.cost_minor),
    notes: r.notes,
    createdBy: r.created_by,
  }));
  const votesByStop: Record<string, Record<string, Vote>> = {};
  for (const v of votesRes.data ?? []) {
    (votesByStop[v.item_id] ??= {})[v.user_id] = v.vote as Vote;
  }
  const commentsByStop: Record<string, Comment[]> = {};
  for (const c of (commentsRes.data ?? []) as Comment[]) (commentsByStop[c.item_id] ??= []).push(c);

  const days = tripDays(ctx.trip.startDate, ctx.trip.endDate);
  const lastUsed = Math.max(0, ...stops.map((s) => s.day));
  const dayCount = days ?? Math.max(1, lastUsed);
  const maxDay = days ?? Math.min(61, lastUsed + 1);
  const requested = Number(Array.isArray(query.day) ? query.day[0] : query.day);
  const day = Number.isInteger(requested) && requested >= 1 && requested <= dayCount ? requested : 1;

  const dayStops = sortStops(stops.filter((s) => s.day === day));
  const warnings = dayWarnings(dayStops);
  const warningFor = Object.fromEntries(warnings.map((w) => [w.stopId, w.message]));
  const distances = distancesFromPrevious(dayStops);
  const places = toMapPlaces(
    staysRes.data ?? [],
    dayStops.map((s) => ({
      id: s.id,
      title: s.title,
      place_url: s.placeUrl,
      day_number: s.day,
      time: s.time,
      latitude: s.lat,
      longitude: s.lng,
    })),
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <Link href={`/trips/${id}?tab=shape`} className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← {ctx.trip.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">Itinerary</h1>
        <Muted>
          {days === null
            ? "The trip has no dates yet, so days are numbered. Times are local to " + ctx.trip.timezone.replace(/_/g, " ") + "."
            : `Times are local to ${ctx.trip.timezone.replace(/_/g, " ")}.`}
        </Muted>
      </div>

      <nav aria-label="Days">
        <ul className="flex gap-2 overflow-x-auto pb-1">
          {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
            <li key={d}>
              <Link
                href={`/trips/${id}/itinerary?day=${d}`}
                aria-current={d === day ? "page" : undefined}
                className={`flex min-h-11 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium ${
                  d === day
                    ? "bg-zinc-950 text-white dark:bg-zinc-50 dark:text-zinc-950"
                    : "border border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                }`}
              >
                {dayLabel(d, ctx.trip.startDate)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {warnings.length > 0 && (
        <Card title="Timing clashes">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-amber-800 dark:text-amber-300">
            {warnings.map((w) => (
              <li key={`${w.stopId}-${w.message}`}>{w.message}</li>
            ))}
          </ul>
        </Card>
      )}

      {dayStops.length === 0 ? (
        <Card>
          <Muted>Nothing planned for {dayLabel(day, ctx.trip.startDate)} yet. Add the first stop below.</Muted>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4" aria-label={`Stops on ${dayLabel(day, ctx.trip.startDate)}`}>
          {dayStops.map((s) => (
            <StopCard
              key={s.id}
              ctx={ctx}
              stop={s}
              votes={votesByStop[s.id] ?? {}}
              comments={commentsByStop[s.id] ?? []}
              distanceKm={distances[s.id]}
              warning={warningFor[s.id]}
              maxDay={maxDay}
            />
          ))}
        </ul>
      )}

      <details open={dayStops.length === 0} className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950 max-md:p-4">
        <summary className="cursor-pointer text-lg font-semibold text-zinc-950 dark:text-zinc-50">Add a stop</summary>
        <div className="mt-4">
          <ActionForm action={addStop.bind(null, id, maxDay)} className="flex flex-col gap-4" ariaLabel="Add a stop">
            <ClientKey />
            <StopFields ctx={ctx} maxDay={maxDay} day={day} />
            <p className="text-sm text-zinc-500">It starts as a proposal; it&apos;s agreed once everyone votes for it.</p>
            <div>
              <SubmitButton className={smallPrimaryButton} pendingText="Adding…">
                Add stop
              </SubmitButton>
            </div>
          </ActionForm>
        </div>
      </details>

      <Card title={`Map · ${dayLabel(day, ctx.trip.startDate)}`}>
        <TripMap places={places} />
      </Card>
    </>
  );
}

export default function ItineraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="flex flex-col gap-6" aria-busy="true">
            <p className="text-zinc-500">Loading itinerary…</p>
            <div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
          </div>
        }
      >
        <Itinerary params={params} searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
