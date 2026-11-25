"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { parseCoordinates } from "@/lib/map-config";
import { createClient } from "@/lib/supabase/server";
import { safeHttpUrl } from "@/lib/url";
import { isRealDate, isUuid } from "@/lib/validation";
import { SAFE_CODES, STALE_CODE } from "@/lib/db-errors";

const SAFE = SAFE_CODES;

async function db() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

async function finish(
  tripId: string,
  prev: ActionState,
  result: PromiseLike<{ error: { code?: string; message: string } | null }>,
  notice?: string,
): Promise<ActionState> {
  const { error } = await result;
  if (error) {
    if (error.code === STALE_CODE) revalidatePath(`/trips/${tripId}`, "layout");
    return { error: error.code && SAFE.has(error.code) ? error.message : "That didn't work. Please try again." };
  }
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice };
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const key = (f: FormData) => (isUuid(str(f, "client_key")) ? str(f, "client_key") : null);
const version = (f: FormData) => {
  const v = Number(f.get("expected_version"));
  return Number.isInteger(v) && v > 0 ? v : null;
};

type PlaceFields = {
  listId: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  url: string | null;
  notes: string | null;
  checkedAt: string | null;
};

function placeFields(f: FormData): PlaceFields | { error: string } {
  const name = str(f, "name");
  if (name.length < 1 || name.length > 120) return { error: "Name the place (up to 120 characters)" };
  const list = str(f, "list_id");
  const coords = str(f, "coordinates");
  let lat: number | null = null;
  let lng: number | null = null;
  if (coords) {
    const c = parseCoordinates(coords);
    if (!c.ok) return { error: c.error };
    lat = c.lat;
    lng = c.lng;
  }
  const urlRaw = str(f, "source_url");
  const url = urlRaw ? safeHttpUrl(urlRaw) : null;
  if (urlRaw && !url) return { error: "Links must start with http:// or https://" };
  const notes = str(f, "notes");
  if (notes.length > 1000) return { error: "Keep notes under 1000 characters" };
  const checked = str(f, "checked_on");
  if (checked && !isRealDate(checked)) return { error: "Enter a real date for when you checked it" };
  return {
    listId: isUuid(list) ? list : null,
    name,
    lat,
    lng,
    url,
    notes: notes || null,
    checkedAt: checked ? `${checked}T12:00:00Z` : null,
  };
}

export async function createList(tripId: string, prev: ActionState, f: FormData) {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const name = str(f, "name");
  if (name.length < 1 || name.length > 60) return { error: "List names are 1 to 60 characters" };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("create_saved_list", { _trip_id: tripId, _name: name, _client_key: key(f) }), "List created.");
}

export async function deleteList(tripId: string, listId: string, expectedVersion: number, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(listId)) return { error: "That list could not be found." };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("delete_saved_list", { _id: listId, _expected_version: expectedVersion }), "List deleted; its places were kept.");
}

export async function createPlace(tripId: string, prev: ActionState, f: FormData) {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const p = placeFields(f);
  if ("error" in p) return p;
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("create_place", {
      _trip_id: tripId,
      _list_id: p.listId,
      _name: p.name,
      _lat: p.lat,
      _lng: p.lng,
      _source_url: p.url,
      _notes: p.notes,
      _checked_at: p.checkedAt,
      _client_key: key(f),
    }),
    "Place saved.",
  );
}

export async function updatePlace(tripId: string, placeId: string, prev: ActionState, f: FormData) {
  if (!isUuid(tripId) || !isUuid(placeId)) return { error: "That place could not be found." };
  const p = placeFields(f);
  if ("error" in p) return p;
  const v = version(f);
  if (v === null) return { error: "Reload the page and try again." };
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("update_place", {
      _id: placeId,
      _list_id: p.listId,
      _name: p.name,
      _lat: p.lat,
      _lng: p.lng,
      _source_url: p.url,
      _notes: p.notes,
      _checked_at: p.checkedAt,
      _expected_version: v,
    }),
    "Saved.",
  );
}

export async function deletePlace(tripId: string, placeId: string, expectedVersion: number, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(placeId)) return { error: "That place could not be found." };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("delete_place", { _id: placeId, _expected_version: expectedVersion }));
}

/** Turns a saved place into a proposed itinerary stop on a chosen day and time. */
export async function addPlaceToItinerary(
  tripId: string,
  place: { id: string; name: string; lat: number | null; lng: number | null; url: string | null },
  maxDay: number,
  prev: ActionState,
  f: FormData,
) {
  if (!isUuid(tripId) || !isUuid(place.id)) return { error: "That place could not be found." };
  const day = Number(str(f, "day"));
  const time = str(f, "time");
  const duration = Number(str(f, "duration"));
  if (!Number.isInteger(day) || day < 1 || day > maxDay) return { error: `Choose a day from 1 to ${maxDay}` };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: "Choose a start time" };
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440) return { error: "Choose how long" };
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("add_stop", {
      _trip_id: tripId,
      _day: day,
      _time: time,
      _duration: duration,
      _title: place.name.slice(0, 120),
      _place_url: place.url,
      _lat: place.lat,
      _lng: place.lng,
      _client_key: key(f),
      _place_id: place.id,
    }),
    "Added to the itinerary as a proposal.",
  );
}
