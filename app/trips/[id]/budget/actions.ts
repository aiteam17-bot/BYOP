"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { createClient } from "@/lib/supabase/server";
import { isUuid, parseBudgetRange, parseRupees } from "@/lib/validation";
import { STALE_CODE } from "@/lib/db-errors";

// Your range is written only to YOUR preferences row (RLS: owner only). Other
// people learn about it only through trip_budget_band(), which releases a
// rounded band once at least 3 people have answered. Nothing here is logged.

async function signedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

function message(error: { code?: string; message: string }): string {
  if (error.code === "22023" || error.code === "42501" || error.code === STALE_CODE || error.code === "P0002") return error.message;
  if (error.code === "23514") return "Check the amounts: the minimum must be at most the maximum.";
  return "That didn't work. Please try again.";
}

export async function saveBudget(tripId: string, prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const parsed = parseBudgetRange(form);
  if (!parsed.ok) return { error: parsed.errors.budget_min ?? parsed.errors.budget_max };
  const { supabase, user } = await signedIn();
  const { error } = await supabase.from("preferences").upsert(
    {
      trip_id: tripId,
      user_id: user.id,
      budget_min_paise: parsed.min,
      budget_max_paise: parsed.max,
    },
    { onConflict: "trip_id,user_id" },
  );
  if (error) return { error: message(error) };
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice: "Saved. Only you can see your numbers." };
}

export async function clearBudget(tripId: string, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const { supabase, user } = await signedIn();
  const { error } = await supabase
    .from("preferences")
    .update({ budget_min_paise: null, budget_max_paise: null })
    .eq("trip_id", tripId)
    .eq("user_id", user.id);
  if (error) return { error: message(error) };
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice: "Your range was removed." };
}

export async function savePlanningBounds(tripId: string, prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const parsed = parseBudgetRange(form);
  if (!parsed.ok) return { error: parsed.errors.budget_min ?? parsed.errors.budget_max };
  if (form.get("group_agreed") !== "yes") return { error: "Confirm the group agreed to these bounds" };
  const { supabase } = await signedIn();
  const { error } = await supabase.rpc("set_planning_bounds", {
    _trip_id: tripId,
    _min_minor: parsed.min,
    _max_minor: parsed.max,
    _group_agreed: true,
  });
  if (error) return { error: message(error) };
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice: "Planning bounds recorded." };
}

export async function clearPlanningBounds(tripId: string, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const { supabase } = await signedIn();
  const { error } = await supabase.rpc("set_planning_bounds", {
    _trip_id: tripId,
    _min_minor: null,
    _max_minor: null,
    _group_agreed: false,
  });
  if (error) return { error: message(error) };
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice: "Planning bounds cleared." };
}

// Budget categories: planned cost per person by category (organiser and
// co-planners; checked again in the database, with versions).
const CATEGORY_KINDS = ["flights", "stay", "local_transport", "food", "activities", "shopping", "other"] as const;

function categoryFields(form: FormData): { kind: string; label: string; planned: number | null; notes: string | null } | { error: string } {
  const kind = String(form.get("kind") ?? "");
  if (!(CATEGORY_KINDS as readonly string[]).includes(kind)) return { error: "Choose a category" };
  const label = String(form.get("label") ?? "").trim();
  if (label.length < 1 || label.length > 60) return { error: "Category names are 1 to 60 characters" };
  const raw = String(form.get("planned") ?? "").trim();
  let planned: number | null = null;
  if (raw !== "") {
    const p = parseRupees(raw);
    if (!p.ok) return { error: p.error };
    planned = p.value;
  }
  const notes = String(form.get("notes") ?? "").trim();
  if (notes.length > 1000) return { error: "Keep notes under 1000 characters" };
  return { kind, label, planned, notes: notes || null };
}

export async function createCategory(tripId: string, prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };
  const f = categoryFields(form);
  if ("error" in f) return f;
  const k = String(form.get("client_key") ?? "");
  const { supabase } = await signedIn();
  const { error } = await supabase.rpc("create_budget_category", {
    _trip_id: tripId,
    _kind: f.kind,
    _label: f.label,
    _planned_per_person_minor: f.planned,
    _notes: f.notes,
    _client_key: isUuid(k) ? k : null,
  });
  if (error) return { error: message(error) };
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice: "Category added." };
}

export async function updateCategory(tripId: string, id: string, prev: ActionState, form: FormData): Promise<ActionState> {
  if (!isUuid(tripId) || !isUuid(id)) return { error: "That category could not be found." };
  const f = categoryFields(form);
  if ("error" in f) return f;
  const v = Number(form.get("expected_version"));
  if (!Number.isInteger(v) || v < 1) return { error: "Reload the page and try again." };
  const { supabase } = await signedIn();
  const { error } = await supabase.rpc("update_budget_category", {
    _id: id,
    _kind: f.kind,
    _label: f.label,
    _planned_per_person_minor: f.planned,
    _notes: f.notes,
    _expected_version: v,
  });
  if (error) {
    if (error.code === STALE_CODE) revalidatePath(`/trips/${tripId}`, "layout");
    return { error: message(error) };
  }
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice: "Saved." };
}

export async function deleteCategory(tripId: string, id: string, expectedVersion: number, prev: ActionState): Promise<ActionState> {
  if (!isUuid(tripId) || !isUuid(id)) return { error: "That category could not be found." };
  const { supabase } = await signedIn();
  const { error } = await supabase.rpc("delete_budget_category", { _id: id, _expected_version: expectedVersion });
  if (error) return { error: message(error) };
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1 };
}
