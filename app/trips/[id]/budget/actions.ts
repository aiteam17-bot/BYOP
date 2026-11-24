"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { createClient } from "@/lib/supabase/server";
import { isUuid, parseBudgetRange } from "@/lib/validation";

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
  if (error.code === "22023" || error.code === "42501") return error.message;
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
