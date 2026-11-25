"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid, parseTripDates } from "@/lib/validation";

export type DatesState = { error?: string; saved?: boolean };

async function currentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
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
