import { Suspense } from "react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ClientKey } from "@/components/client-key";
import { LiveStatus, LiveTrip } from "@/components/live-trip";
import { TripMap } from "@/components/trip-map";
import { Card, Muted, Shell, inputClass, labelClass, smallButton, smallPrimaryButton } from "@/components/ui";
import { canPlan } from "@/lib/decide";
import { formatDate } from "@/lib/format";
import { dayLabel, tripDays } from "@/lib/itinerary";
import { createClient } from "@/lib/supabase/server";
import { loadTripContext, type TripContext } from "@/lib/trip-data";
import { safeHttpUrl } from "@/lib/url";
import { addPlaceToItinerary, createList, createPlace, deleteList, deletePlace, updatePlace } from "./actions";

export const metadata = { title: "Saved places · Group Trip Planner" };

type List = { id: string; name: string; version: number; created_by: string | null };
type Place = {
  id: string;
  list_id: string | null;
  name: string;
  latitude: number | string | null;
  longitude: number | string | null;
  source_url: string | null;
  notes: string | null;
  checked_at: string | null;
  created_by: string | null;
  version: number;
};

function PlaceFields({ lists, place }: { lists: List[]; place?: Place }) {
  return (
    <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
      <label className={`${labelClass} col-span-2 max-md:col-span-1`}>
        Name
        <input name="name" required maxLength={120} defaultValue={place?.name} placeholder="Name of the place" className={inputClass} />
      </label>
      <label className={labelClass}>
        List
        <select name="list_id" defaultValue={place?.list_id ?? ""} className={inputClass}>
          <option value="">No list</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Map location (optional)
        <input
          name="coordinates"
          placeholder="latitude, longitude"
          defaultValue={place?.latitude !== null && place?.latitude !== undefined ? `${Number(place.latitude)}, ${Number(place.longitude)}` : ""}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Source link (optional)
        <input name="source_url" type="url" placeholder="https://…" defaultValue={place?.source_url ?? ""} className={inputClass} />
      </label>
      <label className={labelClass}>
        Details checked on (optional)
        <input name="checked_on" type="date" defaultValue={place?.checked_at?.slice(0, 10) ?? ""} className={inputClass} />
      </label>
      <label className={`${labelClass} col-span-2 max-md:col-span-1`}>
        Notes (optional)
        <textarea name="notes" maxLength={1000} rows={2} defaultValue={place?.notes ?? ""} className={inputClass} />
      </label>
      <p className="col-span-2 text-sm text-zinc-500 max-md:col-span-1">
        To get a location: on openstreetmap.org or Google Maps, right-click the place and copy the coordinates.
      </p>
    </div>
  );
}

function PlaceCard({ ctx, place, lists, maxDay }: { ctx: TripContext; place: Place; lists: List[]; maxDay: number }) {
  const canEdit = place.created_by === ctx.userId || canPlan(ctx.me.role);
  const link = safeHttpUrl(place.source_url);
  const lat = place.latitude === null ? null : Number(place.latitude);
  const lng = place.longitude === null ? null : Number(place.longitude);
  const author = ctx.members.find((m) => m.userId === place.created_by)?.name ?? "someone";
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h3 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{place.name}</h3>
      <ul className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
        <li>{lat === null ? "No map location yet" : `${lat}, ${lng}`}</li>
        {link && (
          <li>
            <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-700 underline dark:text-blue-400">
              Source ↗
            </a>
          </li>
        )}
        <li>{place.checked_at ? `Details checked ${formatDate(place.checked_at.slice(0, 10))}` : "Check date not recorded"}</li>
        {place.notes && <li className="whitespace-pre-line">{place.notes}</li>}
        <li>Saved by {author}</li>
      </ul>
      <details>
        <summary className="cursor-pointer text-sm underline">Add to the itinerary</summary>
        <ActionForm
          action={addPlaceToItinerary.bind(null, ctx.trip.id, { id: place.id, name: place.name, lat, lng, url: link }, maxDay)}
          className="mt-3 grid grid-cols-3 items-end gap-3 max-md:grid-cols-1"
          ariaLabel={`Add ${place.name} to the itinerary`}
        >
          <ClientKey />
          <label className={labelClass}>
            Day
            <select name="day" defaultValue="1" className={inputClass}>
              {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d, ctx.trip.startDate)}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Starts
            <input name="time" type="time" required className={inputClass} />
          </label>
          <label className={labelClass}>
            How long
            <select name="duration" defaultValue="60" className={inputClass}>
              {[30, 60, 90, 120, 180, 240].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60} h`}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-3 max-md:col-span-1">
            <SubmitButton className={smallPrimaryButton} pendingText="Adding…">
              Propose this stop
            </SubmitButton>
          </div>
        </ActionForm>
      </details>
      {canEdit && (
        <>
          <details>
            <summary className="cursor-pointer text-sm underline">Edit</summary>
            <ActionForm action={updatePlace.bind(null, ctx.trip.id, place.id)} className="mt-3 flex flex-col gap-4" ariaLabel={`Edit ${place.name}`}>
              <input type="hidden" name="expected_version" value={place.version} />
              <PlaceFields lists={lists} place={place} />
              <div>
                <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
                  Save
                </SubmitButton>
              </div>
            </ActionForm>
          </details>
          <details>
            <summary className="cursor-pointer text-sm text-red-700 underline dark:text-red-400">Delete</summary>
            <ActionForm action={deletePlace.bind(null, ctx.trip.id, place.id, place.version)} className="mt-2">
              <SubmitButton className={smallButton} pendingText="Deleting…">
                Yes, delete this place
              </SubmitButton>
            </ActionForm>
          </details>
        </>
      )}
    </li>
  );
}

async function Places({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadTripContext(id);
  const supabase = await createClient();
  const [listsRes, placesRes] = await Promise.all([
    supabase.from("saved_lists").select("id, name, version, created_by").eq("trip_id", id).order("name"),
    supabase
      .from("saved_places")
      .select("id, list_id, name, latitude, longitude, source_url, notes, checked_at, created_by, version")
      .eq("trip_id", id)
      .order("name"),
  ]);
  if (listsRes.error || placesRes.error) throw new Error("Could not load saved places");
  const lists = (listsRes.data ?? []) as List[];
  const places = (placesRes.data ?? []) as Place[];
  const maxDay = tripDays(ctx.trip.startDate, ctx.trip.endDate) ?? 14;
  const groups: { list: List | null; places: Place[] }[] = [
    ...lists.map((l) => ({ list: l, places: places.filter((p) => p.list_id === l.id) })),
    { list: null, places: places.filter((p) => p.list_id === null) },
  ];
  const mapPlaces = places.map((p) => ({
    id: `place-${p.id}`,
    kind: "itinerary" as const,
    name: p.name,
    detail: lists.find((l) => l.id === p.list_id)?.name ?? "Saved place",
    url: safeHttpUrl(p.source_url),
    lat: p.latitude === null ? null : Number(p.latitude),
    lng: p.longitude === null ? null : Number(p.longitude),
  }));

  return (
    <LiveTrip tripId={id} userId={ctx.userId} displayName={ctx.me.name}>
      <div className="flex flex-col gap-1">
        <Link href={`/trips/${id}?tab=shape`} className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← {ctx.trip.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">Saved places</h1>
        <Muted>Places members found, in lists. Nothing is suggested automatically.</Muted>
        <LiveStatus />
      </div>

      <Card title="Save a place">
        <ActionForm action={createPlace.bind(null, id)} className="flex flex-col gap-4" ariaLabel="Save a place">
          <ClientKey />
          <PlaceFields lists={lists} />
          <div>
            <SubmitButton className={smallPrimaryButton} pendingText="Saving…">
              Save place
            </SubmitButton>
          </div>
        </ActionForm>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm underline">New list</summary>
          <ActionForm action={createList.bind(null, id)} className="mt-3 flex gap-3 max-md:flex-col" ariaLabel="New list">
            <ClientKey />
            <label className="sr-only" htmlFor="new-list">
              List name
            </label>
            <input id="new-list" name="name" required maxLength={60} placeholder="e.g. Beaches" className={inputClass} />
            <SubmitButton className={smallButton} pendingText="Creating…">
              Create list
            </SubmitButton>
          </ActionForm>
        </details>
      </Card>

      {places.length === 0 ? (
        <Card>
          <Muted>No saved places yet. Save the first one above.</Muted>
        </Card>
      ) : (
        groups
          .filter((g) => g.places.length > 0 || g.list)
          .map((g) => (
            <section key={g.list?.id ?? "none"} aria-label={g.list?.name ?? "Not in a list"} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{g.list?.name ?? "Not in a list"}</h2>
                {g.list && (g.list.created_by === ctx.userId || canPlan(ctx.me.role)) && (
                  <ActionForm action={deleteList.bind(null, id, g.list.id, g.list.version)}>
                    <SubmitButton className="text-sm text-zinc-500 underline" pendingText="Deleting…">
                      Delete list (keeps its places)
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>
              {g.places.length === 0 ? (
                <p className="text-sm text-zinc-500">Empty list.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {g.places.map((p) => (
                    <PlaceCard key={p.id} ctx={ctx} place={p} lists={lists} maxDay={maxDay} />
                  ))}
                </ul>
              )}
            </section>
          ))
      )}

      <Card title="Map of saved places">
        <TripMap places={mapPlaces} />
      </Card>
    </LiveTrip>
  );
}

export default function PlacesPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Shell>
      <Suspense fallback={<Muted>Loading saved places…</Muted>}>
        <Places params={params} />
      </Suspense>
    </Shell>
  );
}
