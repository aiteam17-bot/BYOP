"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseStayInput, type StayErrors } from "@/lib/stay-input";
import { isUuid, parseTripDates } from "@/lib/validation";

export type AddStayState = { errors?: StayErrors; message?: string; saved?: number };
export type DatesState = { error?: string; saved?: boolean };

async function currentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function addStay(
  tripId: string,
  prev: AddStayState,
  formData: FormData,
): Promise<AddStayState> {
  if (!isUuid(tripId)) return { message: "That trip could not be found." };

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseStayInput(formData, today);
  if (!parsed.ok) return { errors: parsed.errors };

  const { supabase, user } = await currentUser();

  // Row-level security checks you belong to this trip and that added_by is you.
  const { error } = await supabase.from("stays").insert({
    trip_id: tripId,
    added_by: user.id,
    ...parsed.data,
  });
  if (error) return { message: "We couldn't save that stay. Please try again." };

  revalidatePath(`/trips/${tripId}/stays`);
  return { saved: (prev.saved ?? 0) + 1 };
}

export async function removeStay(tripId: string, stayId: string): Promise<void> {
  if (!isUuid(tripId) || !isUuid(stayId)) return;
  const { supabase, user } = await currentUser();
  // You can only remove stays you added yourself.
  await supabase
    .from("stays")
    .delete()
    .eq("id", stayId)
    .eq("trip_id", tripId)
    .eq("added_by", user.id);
  revalidatePath(`/trips/${tripId}/stays`);
}

export async function setTripDates(
  tripId: string,
  _prev: DatesState,
  formData: FormData,
): Promise<DatesState> {
  if (!isUuid(tripId)) return { error: "That trip could not be found." };

  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : "";
  };
  const parsed = parseTripDates(get("start_date"), get("end_date"));
  if (!parsed.ok) return { error: parsed.error };
  if (parsed.startDate === null) return { error: "Enter both dates" };

  const { supabase } = await currentUser();
  const { data, error } = await supabase
    .from("trips")
    .update({ start_date: parsed.startDate, end_date: parsed.endDate })
    .eq("id", tripId)
    .select("id");

  // Row-level security lets only the organiser change a trip.
  if (error || !data || data.length === 0) {
    return { error: "Only the organiser can change the trip dates." };
  }

  revalidatePath(`/trips/${tripId}/stays`);
  revalidatePath(`/trips/${tripId}`);
  return { saved: true };
}
