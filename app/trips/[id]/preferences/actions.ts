"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid, parsePreferences, type FieldErrors } from "@/lib/validation";

export type PreferencesState = { errors?: FieldErrors; message?: string };

export async function savePreferences(
  tripId: string,
  _prev: PreferencesState,
  formData: FormData,
): Promise<PreferencesState> {
  if (!isUuid(tripId)) return { message: "That trip could not be found." };

  const parsed = parsePreferences(formData);
  if (!parsed.ok) return { errors: parsed.errors };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Row-level security only lets you write your own row, and only for a trip
  // you belong to.
  const { error } = await supabase.from("preferences").upsert(
    {
      trip_id: tripId,
      user_id: user.id,
      ...parsed.data,
      submitted_at: new Date().toISOString(),
    },
    { onConflict: "trip_id,user_id" },
  );

  if (error) {
    return { message: "We couldn't save your answers. Please try again." };
  }

  redirect(`/trips/${tripId}`);
}
