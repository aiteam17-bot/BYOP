"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  isNudgeTopic,
  isRsvp,
  parseDestinationOption,
  parseTripName,
} from "@/lib/decide";
import { createClient } from "@/lib/supabase/server";
import { isUuid, parseTripDates } from "@/lib/validation";

// Every action: signed-in check here, then ONE database function that
// re-checks membership and role, validates, and runs as a transaction. Hiding a
// button in the UI is never the permission check.

export type ActionState = { error?: string; notice?: string; done?: number };

const SAFE_CODES = new Set(["42501", "22023", "P0002"]);

async function signedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

async function run(
  tripId: string,
  prev: ActionState,
  call: (supabase: Awaited<ReturnType<typeof createClient>>) => PromiseLike<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>,
  notice?: (data: unknown) => string | undefined,
): Promise<ActionState> {
  const supabase = await signedIn();
  const { data, error } = await call(supabase);
  if (error) {
    // Our own database messages are written for people; anything else is not.
    return {
      error:
        error.code && SAFE_CODES.has(error.code)
          ? error.message
          : "That didn't work. Please try again.",
    };
  }
  revalidatePath(`/trips/${tripId}`, "layout");
  return { done: (prev.done ?? 0) + 1, notice: notice?.(data) };
}

const notFound: ActionState = { error: "That trip could not be found." };

export async function renameTrip(tripId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId)) return notFound;
  const parsed = parseTripName(form);
  if (!parsed.ok) return { error: parsed.error };
  return run(tripId, prev, (s) => s.rpc("rename_trip", { _trip_id: tripId, _name: parsed.name }), () => "Saved");
}

export async function setMemberRole(tripId: string, userId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId) || !isUuid(userId)) return notFound;
  const role = form.get("role");
  if (role !== "co_planner" && role !== "member") return { error: "Choose co-planner or traveller" };
  return run(tripId, prev, (s) =>
    s.rpc("set_member_role", { _trip_id: tripId, _user_id: userId, _role: role }),
  );
}

export async function setRsvp(tripId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId)) return notFound;
  const rsvp = form.get("rsvp");
  if (!isRsvp(rsvp)) return { error: "Choose In, Maybe or Not yet" };
  return run(tripId, prev, (s) => s.rpc("set_rsvp", { _trip_id: tripId, _rsvp: rsvp }));
}

export async function addDatesOption(tripId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId)) return notFound;
  const start = form.get("start_date");
  const end = form.get("end_date");
  const dates = parseTripDates(typeof start === "string" ? start : "", typeof end === "string" ? end : "");
  if (!dates.ok) return { error: dates.error };
  if (!dates.startDate || !dates.endDate) return { error: "Enter a start date and an end date" };
  return run(tripId, prev, (s) =>
    s.rpc("add_poll_option", {
      _trip_id: tripId,
      _kind: "dates",
      _start_date: dates.startDate,
      _end_date: dates.endDate,
    }),
  );
}

export async function addDestinationOption(tripId: string, prev: ActionState, form: FormData) {
  if (!isUuid(tripId)) return notFound;
  const parsed = parseDestinationOption(form);
  if (!parsed.ok) return { error: parsed.error };
  return run(tripId, prev, (s) =>
    s.rpc("add_poll_option", { _trip_id: tripId, _kind: "destination", _label: parsed.label }),
  );
}

export async function removeOption(tripId: string, optionId: string, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(optionId)) return notFound;
  return run(tripId, prev, (s) => s.rpc("remove_poll_option", { _option_id: optionId }));
}

export async function castVote(tripId: string, optionId: string, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(optionId)) return notFound;
  return run(tripId, prev, (s) => s.rpc("cast_vote", { _option_id: optionId }));
}

export async function settlePoll(tripId: string, pollId: string, optionId: string, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(pollId) || !isUuid(optionId)) return notFound;
  return run(tripId, prev, (s) => s.rpc("settle_poll", { _poll_id: pollId, _option_id: optionId }));
}

export async function reopenPoll(tripId: string, pollId: string, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(pollId)) return notFound;
  return run(tripId, prev, (s) => s.rpc("reopen_poll", { _poll_id: pollId }));
}

export async function nudgeMember(tripId: string, userId: string, topic: string, prev: ActionState) {
  if (!isUuid(tripId) || !isUuid(userId)) return notFound;
  if (!isNudgeTopic(topic)) return { error: "Unknown reminder" };
  return run(
    tripId,
    prev,
    (s) => s.rpc("nudge_member", { _trip_id: tripId, _to_user: userId, _topic: topic }),
    (data) => (data === "recent" ? "Already reminded in the last 12 hours" : "Reminder sent in the app"),
  );
}
