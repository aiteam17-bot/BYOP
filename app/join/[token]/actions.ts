"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type JoinState = { error?: string };

type RedeemResult = {
  status: "joined" | "already_member" | "invalid" | "rate_limited";
  trip_id?: string;
};

// Joining is one database call (redeem_invite): it checks the signed-in user,
// the hashed token, expiry and revocation, rate-limits wrong tokens, and adds
// the membership in one transaction. Calling it twice is harmless.
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

  const { data, error } = await supabase.rpc("redeem_invite", {
    _token: token,
    _display_name: displayName === "" ? null : displayName,
  });
  if (error) return { error: "That didn't work. Please try again." };

  const result = data as RedeemResult;
  if ((result.status === "joined" || result.status === "already_member") && result.trip_id) {
    redirect(`/trips/${result.trip_id}`);
  }
  if (result.status === "rate_limited") {
    return { error: "Too many invite attempts. Wait 15 minutes and try again." };
  }
  return { error: "This invite link is invalid, expired or was revoked. Ask for a new one." };
}
