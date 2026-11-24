"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseTripInput } from "@/lib/validation";

export type NewTripState = { error?: string };

export async function createTrip(
  _prev: NewTripState,
  formData: FormData,
): Promise<NewTripState> {
  const parsed = parseTripInput(formData);
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // owner_id defaults to the signed-in user; a database trigger makes the
  // creator the trip's first member (role: owner).
  const { data, error } = await supabase
    .from("trips")
    .insert({
      name: parsed.name,
      destination: parsed.destination,
      start_date: parsed.startDate,
      end_date: parsed.endDate,
      timezone: parsed.timezone,
      currency: parsed.currency,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { error: "We couldn't create the trip. Please try again." };
  }

  redirect(`/trips/${data.id}`);
}
