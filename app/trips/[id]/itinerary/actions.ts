"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { parseStopForm } from "@/lib/itinerary";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// Every action: session check here, then ONE database function that checks
// trip membership and role, validates again and runs as a transaction.
// Edits carry the version the person saw; 40001 means someone else changed
// it first, and we say so instead of overwriting their change.

const SAFE = new Set(["42501", "22023", "P0002", "40001"]);

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
    // Show the latest data behind a conflict message straight away.
    if (error.code === "40001") revalidatePath(`/trips/${tripId}`, "layout");
    return { error: error.code && SAFE.has(error.code) ? error.message : "That didn't work. Please try again." };
  }
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice };
}

function key(form: FormData): string | null {
  const k = form.get("client_key");
  return typeof k === "string" && isUuid(k) ? k : null;
}

function version(form: FormData): number | null {
  const v = Number(form.get("expected_version"));
  return Number.isInteger(v) && v > 0 ? v : null;
}

const variantOrNull = (v: string | null) => (v && isUuid(v) ? v : null);

export async function addStop(tripId: string, maxDay: number, variantId: string | null, prev: ActionState, form: FormData) {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const parsed = parseStopForm(form, maxDay);
  if (!parsed.ok) return { error: parsed.error };
  const d = parsed.data;
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("add_stop", {
      _trip_id: tripId,
      _day: d.day,
      _time: d.time,
      _duration: d.duration,
      _title: d.title,
      _place_url: d.placeUrl,
      _lat: d.lat,
      _lng: d.lng,
      _cost: d.costMinor,
      _notes: d.notes,
      _client_key: key(form),
      _variant_id: variantOrNull(variantId),
      _place_id: d.placeId,
      _travel_minutes: d.travelMinutes,
    }),
    "Stop added as a proposal.",
  );
}

export async function updateStop(
  tripId: string,
  itemId: string,
  maxDay: number,
  variantId: string | null,
  prev: ActionState,
  form: FormData,
) {
  if (!isUuid(tripId) || !isUuid(itemId)) return { error: "That stop could not be found." };
  const parsed = parseStopForm(form, maxDay);
  if (!parsed.ok) return { error: parsed.error };
  const v = version(form);
  if (v === null) return { error: "Reload the page and try again." };
  const d = parsed.data;
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("update_stop", {
      _item_id: itemId,
      _day: d.day,
      _time: d.time,
      _duration: d.duration,
      _title: d.title,
      _place_url: d.placeUrl,
      _lat: d.lat,
      _lng: d.lng,
      _cost: d.costMinor,
      _notes: d.notes,
      _expected_version: v,
      _variant_id: variantOrNull(variantId),
      _place_id: d.placeId,
      _travel_minutes: d.travelMinutes,
    }),
    "Saved. If its time, day, place or cost changed, votes start again.",
  );
}

export async function deleteStop(tripId: string, itemId: string, expectedVersion: number, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(itemId)) return { error: "That stop could not be found." };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("delete_stop_checked", { _item_id: itemId, _expected_version: expectedVersion }));
}

export async function voteStop(tripId: string, itemId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId) || !isUuid(itemId)) return { error: "That stop could not be found." };
  const v = form.get("vote");
  const vote = v === "for" || v === "against" ? v : v === "clear" ? null : undefined;
  if (vote === undefined) return { error: "Vote for or against" };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("vote_stop", { _item_id: itemId, _vote: vote }));
}

export async function addComment(tripId: string, itemId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId) || !isUuid(itemId)) return { error: "That stop could not be found." };
  const body = form.get("body");
  const text = typeof body === "string" ? body.trim() : "";
  if (text.length < 1 || text.length > 1000) return { error: "Comments are 1 to 1000 characters" };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("add_comment", { _item_id: itemId, _body: text, _client_key: key(form) }));
}

export async function deleteComment(tripId: string, commentId: string, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(commentId)) return { error: "That comment could not be found." };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("delete_comment", { _comment_id: commentId }));
}

function variantFields(form: FormData): { name: string; description: string | null } | { error: string } {
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  if (name.length < 1 || name.length > 60) return { error: "Variant names are 1 to 60 characters" };
  if (description.length > 1000) return { error: "Keep the description under 1000 characters" };
  return { name, description: description || null };
}

export async function createVariant(tripId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const f = variantFields(form);
  if ("error" in f) return f;
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("create_variant", { _trip_id: tripId, _name: f.name, _description: f.description, _client_key: key(form) }),
    "Variant created.",
  );
}

export async function updateVariant(tripId: string, variantId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId) || !isUuid(variantId)) return { error: "That variant could not be found." };
  const f = variantFields(form);
  if ("error" in f) return f;
  const v = version(form);
  if (v === null) return { error: "Reload the page and try again." };
  const supabase = await db();
  return finish(
    tripId,
    prev,
    supabase.rpc("update_variant", { _id: variantId, _name: f.name, _description: f.description, _expected_version: v }),
    "Saved.",
  );
}

export async function deleteVariant(tripId: string, variantId: string, expectedVersion: number, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(variantId)) return { error: "That variant could not be found." };
  const supabase = await db();
  return finish(tripId, prev, supabase.rpc("delete_variant", { _id: variantId, _expected_version: expectedVersion }));
}
