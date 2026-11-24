import { notFound, redirect } from "next/navigation";
import {
  isNudgeTopic,
  isPollKind,
  isRole,
  isRsvp,
  type Member,
  type NudgeTopic,
  type Poll,
  type PollKind,
} from "@/lib/decide";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

export type TripContext = {
  userId: string;
  trip: {
    id: string;
    name: string;
    destination: string | null;
    startDate: string | null;
    endDate: string | null;
    inviteToken: string;
  };
  me: Member;
  members: Member[];
  polls: Partial<Record<PollKind, Poll>>;
  /** Nudges sent to me: topic -> sender's name. */
  nudgesToMe: Partial<Record<NudgeTopic, string>>;
  myCardAnswered: boolean;
  cardsAnswered: number;
};

/**
 * Everything Trip home and Decide need, read as the signed-in user. Row-level
 * security limits every query to trips this user belongs to; a trip they are
 * not on looks exactly like one that does not exist (404). Nothing is cached
 * across requests or users.
 */
export async function loadTripContext(tripId: string): Promise<TripContext> {
  if (!isUuid(tripId)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [tripRes, membersRes, pollsRes, optionsRes, votesRes, nudgesRes, answeredRes] =
    await Promise.all([
      supabase
        .from("trips")
        .select("id, name, destination, start_date, end_date, invite_token")
        .eq("id", tripId)
        .maybeSingle(),
      supabase
        .from("trip_members")
        .select("user_id, display_name, role, rsvp")
        .eq("trip_id", tripId),
      supabase
        .from("polls")
        .select("id, kind, status, settled_option_id")
        .eq("trip_id", tripId),
      supabase
        .from("poll_options")
        .select("id, poll_id, label, start_date, end_date, created_by, created_at")
        .eq("trip_id", tripId)
        .order("created_at"),
      supabase.from("poll_votes").select("poll_id, option_id, user_id").eq("trip_id", tripId),
      supabase
        .from("nudges")
        .select("topic, from_user")
        .eq("trip_id", tripId)
        .eq("to_user", user.id),
      supabase.rpc("trip_response_status", { _trip_id: tripId }),
    ]);

  // A failed read is an error (shown with a retry button), never an empty trip.
  for (const res of [tripRes, membersRes, pollsRes, optionsRes, votesRes, nudgesRes, answeredRes]) {
    if (res.error) throw new Error("Could not load this trip");
  }
  const trip = tripRes.data;
  if (!trip) notFound();

  const members: Member[] = (membersRes.data ?? [])
    .map((m) => ({
      userId: m.user_id as string,
      name: m.display_name as string,
      role: isRole(m.role) ? m.role : "member",
      rsvp: isRsvp(m.rsvp) ? m.rsvp : "not_yet",
    }))
    .sort((a, b) => {
      const rank = { owner: 0, co_planner: 1, member: 2 } as const;
      return rank[a.role] - rank[b.role] || a.name.localeCompare(b.name);
    });
  const me = members.find((m) => m.userId === user.id);
  if (!me) notFound();

  const polls: Partial<Record<PollKind, Poll>> = {};
  for (const p of pollsRes.data ?? []) {
    if (!isPollKind(p.kind)) continue;
    polls[p.kind] = {
      id: p.id,
      kind: p.kind,
      status: p.status === "settled" ? "settled" : "open",
      settledOptionId: p.settled_option_id,
      options: (optionsRes.data ?? [])
        .filter((o) => o.poll_id === p.id)
        .map((o) => ({
          id: o.id,
          label: o.label,
          startDate: o.start_date,
          endDate: o.end_date,
          createdBy: o.created_by,
        })),
      votes: Object.fromEntries(
        (votesRes.data ?? []).filter((v) => v.poll_id === p.id).map((v) => [v.user_id, v.option_id]),
      ),
    };
  }

  const nameOf = (id: string) => members.find((m) => m.userId === id)?.name ?? "Someone";
  const nudgesToMe: Partial<Record<NudgeTopic, string>> = {};
  for (const n of nudgesRes.data ?? []) {
    if (isNudgeTopic(n.topic)) nudgesToMe[n.topic] = nameOf(n.from_user);
  }

  const answered = (answeredRes.data ?? []) as { user_id: string; has_answered: boolean }[];

  return {
    userId: user.id,
    trip: {
      id: trip.id,
      name: trip.name,
      destination: trip.destination,
      startDate: trip.start_date,
      endDate: trip.end_date,
      inviteToken: trip.invite_token,
    },
    me,
    members,
    polls,
    nudgesToMe,
    myCardAnswered: answered.some((a) => a.user_id === user.id && a.has_answered),
    cardsAnswered: answered.filter((a) => a.has_answered).length,
  };
}
