"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type JoinState = { error?: string };

export async function joinTrip(
  token: string,
  _prev: JoinState,
  formData: FormData,
): Promise<JoinState> {
  const rawName = formData.get("display_name");
  const displayName = typeof rawName === "string" ? rawName.trim() : "";
  if (displayName.length > 60) {
    return { error: "Keep your name under 60 characters" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: tripId, error } = await supabase.rpc("join_trip", {
    _token: token,
    _display_name: displayName === "" ? null : displayName,
  });

  if (error || typeof tripId !== "string") {
    return { error: "This invite link isn't valid any more." };
  }

  redirect(`/trips/${tripId}`);
}
