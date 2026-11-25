"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { buildGenericRequest } from "@/lib/ai/generic-request";
import { AI_ERROR_MESSAGES, aiConfig, generateIdeas } from "@/lib/ai/gemini";
import { rankIdeas } from "@/lib/ai/ideas";
import { opFromForm, parseOps } from "@/lib/concierge";
import { SAFE_CODES, STALE_CODE } from "@/lib/db-errors";
import { loadShapeInputs } from "@/lib/plan-data";
import { chooseStays } from "@/lib/plan-shapes";
import { createClient } from "@/lib/supabase/server";
import { safeHttpUrl } from "@/lib/url";
import { isUuid, parseRupees } from "@/lib/validation";

// Every action: session check here, then database functions that check trip
// membership and role, validate again and run as one transaction.

const SAFE = new Set([...SAFE_CODES, "RL429"]);

async function db() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

function message(error: { code?: string; message: string }): string {
  return error.code && SAFE.has(error.code) ? error.message : "That didn't work. Please try again.";
}

function done(tripId: string, prev: ActionState, notice: string): ActionState {
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice };
}

// ---------------------------------------------------------------------------
// Plan shapes
// ---------------------------------------------------------------------------

export async function buildShapes(tripId: string, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const { supabase } = await db();
  const inputs = await loadShapeInputs(supabase, tripId);
  if (!inputs) return { error: "That trip could not be found." };
  const { error } = await supabase.rpc("save_plan_shapes", { _trip_id: tripId, _choices: chooseStays(inputs) });
  if (error) return { error: message(error) };
  return done(tripId, prev, "Tight, Balanced and Splurge saved from the current dates, bounds and quotes.");
}

export async function chooseShape(tripId: string, shapeId: string, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId) || !isUuid(shapeId)) return { error: "That plan could not be found." };
  const { supabase } = await db();
  const { error } = await supabase.rpc("choose_plan_shape", { _shape_id: shapeId });
  if (error) return { error: message(error) };
  return done(tripId, prev, "Marked as the plan the group is going with.");
}

// ---------------------------------------------------------------------------
// Limited AI ideas
// ---------------------------------------------------------------------------

export async function setAiOptIn(tripId: string, on: boolean, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const { supabase } = await db();
  const { error } = await supabase.rpc("set_ai_ideas_opt_in", { _trip_id: tripId, _on: on });
  if (error) return { error: message(error) };
  return done(tripId, prev, on ? "AI ideas turned on for this trip (limited mode)." : "AI ideas turned off for this trip.");
}

export async function requestIdeas(tripId: string, prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const config = aiConfig();
  if (!config.available) return { error: AI_ERROR_MESSAGES.unavailable };
  const { supabase, user } = await db();

  // Only generic facts are read for the request: destination, start month,
  // member count. Member names are read only to refuse a destination that
  // contains one; they are never sent.
  const [tripRes, membersRes] = await Promise.all([
    supabase.from("trips").select("destination, start_date").eq("id", tripId).maybeSingle(),
    supabase.from("trip_members").select("display_name").eq("trip_id", tripId),
  ]);
  if (tripRes.error || !tripRes.data || membersRes.error) return { error: "That trip could not be found." };
  const built = buildGenericRequest({
    destination: tripRes.data.destination,
    startDate: tripRes.data.start_date,
    memberCount: membersRes.data.length,
    pace: String(form.get("pace") ?? ""),
    interests: form.getAll("interests").map(String),
    forbiddenWords: membersRes.data.map((m) => m.display_name).flatMap((n: string) => n.split(/\s+/)),
  });
  if (!built.ok) return { error: built.error };

  const begun = await supabase.rpc("begin_ai_request", { _trip_id: tripId, _request_bytes: built.bytes });
  if (begun.error) return { error: message(begun.error) };
  const requestId = begun.data as string;

  const result = await generateIdeas(built.request, { config });
  if (!result.ok) {
    await supabase.rpc("finish_ai_request", {
      _request_id: requestId, _ok: false, _error_code: result.code, _response_bytes: result.responseBytes, _ideas: null,
    });
    return { error: AI_ERROR_MESSAGES[result.code] };
  }

  // Local only: drop what the trip already has, rank by my own interests.
  const [mine, stops, places] = await Promise.all([
    supabase.from("preferences").select("interests").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle(),
    supabase.from("itinerary_items").select("title").eq("trip_id", tripId),
    supabase.from("saved_places").select("name").eq("trip_id", tripId),
  ]);
  const ranked = rankIdeas(result.ideas, {
    myInterests: (mine.data?.interests as string[] | null) ?? [],
    existingNames: [...(stops.data ?? []).map((s) => s.title as string), ...(places.data ?? []).map((p) => p.name as string)],
  });
  const finished = await supabase.rpc("finish_ai_request", {
    _request_id: requestId, _ok: true, _error_code: null, _response_bytes: result.responseBytes, _ideas: ranked,
  });
  if (finished.error) return { error: message(finished.error) };
  const n = finished.data as number;
  return done(
    tripId,
    prev,
    n === 0
      ? "No new ideas came back (anything the trip already has was left out)."
      : `${n} unverified idea${n === 1 ? "" : "s"} added. Check each one before using it.`,
  );
}

export async function confirmIdea(tripId: string, ideaId: string, version: number, prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(tripId) || !isUuid(ideaId)) return { error: "That idea could not be found." };
  const url = safeHttpUrl(String(form.get("place_url") ?? "").trim());
  if (!url) return { error: "Add the link where you checked the place (http:// or https://)." };
  const hours = String(form.get("hours") ?? "").trim();
  if (hours.length < 1 || hours.length > 120) return { error: "Write the opening hours you checked (up to 120 characters)." };
  const minutes = Number(form.get("minutes"));
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) return { error: "Time needed is 5 minutes to 24 hours." };
  const priceRaw = String(form.get("price") ?? "").trim();
  if (priceRaw === "") return { error: "Enter the price you checked (0 if free)." };
  const price = parseRupees(priceRaw);
  if (!price.ok || price.value === null) return { error: price.ok ? "Enter the price you checked (0 if free)." : price.error };
  if (form.get("checked") !== "yes") return { error: "Tick the box to say you checked these yourself." };
  const { supabase } = await db();
  const { error } = await supabase.rpc("confirm_ai_suggestion", {
    _id: ideaId, _place_url: url, _hours: hours, _minutes: minutes, _price_minor: price.value, _expected_version: version,
  });
  if (error) return { error: message(error) };
  return done(tripId, prev, "Confirmed. It can now be proposed for the itinerary.");
}

export async function dismissIdea(tripId: string, ideaId: string, version: number, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId) || !isUuid(ideaId)) return { error: "That idea could not be found." };
  const { supabase } = await db();
  const { error } = await supabase.rpc("dismiss_ai_suggestion", { _id: ideaId, _expected_version: version });
  if (error) return { error: message(error) };
  return done(tripId, prev, "Set aside.");
}

// ---------------------------------------------------------------------------
// Concierge proposals
// ---------------------------------------------------------------------------

export async function proposeChange(tripId: string, maxDay: number, prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const parsed = parseOps([opFromForm(form)], maxDay);
  if (!parsed.ok) return { error: parsed.error };
  const key = String(form.get("client_key") ?? "");
  const { supabase } = await db();
  const { error } = await supabase.rpc("propose_change", {
    _trip_id: tripId, _ops: parsed.ops, _client_key: isUuid(key) ? key : null,
  });
  if (error) return { error: message(error) };
  return done(tripId, prev, "Proposed. Anyone allowed to make the change can Accept it.");
}

export async function acceptProposal(tripId: string, proposalId: string, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId) || !isUuid(proposalId)) return { error: "That proposal could not be found." };
  const { supabase } = await db();
  const { data, error } = await supabase.rpc("accept_proposal", { _id: proposalId });
  if (error) {
    if (error.code === STALE_CODE) revalidatePath(`/trips/${tripId}`, "layout");
    return { error: message(error) };
  }
  if (data === "stale") {
    revalidatePath(`/trips/${tripId}`, "layout");
    return { error: "The plan changed since this was proposed, so nothing was applied. Make the proposal again from the current plan." };
  }
  return done(tripId, prev, data === "already_applied" ? "Already applied." : "Applied to the itinerary.");
}

export async function dismissProposal(tripId: string, proposalId: string, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId) || !isUuid(proposalId)) return { error: "That proposal could not be found." };
  const { supabase } = await db();
  const { error } = await supabase.rpc("dismiss_proposal", { _id: proposalId });
  if (error) return { error: message(error) };
  return done(tripId, prev, "Set aside.");
}
