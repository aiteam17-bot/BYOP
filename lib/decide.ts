// Pure rules for 01 Trip home and 02 Decide. No database access here, so the
// same logic is unit-tested and used by the server-rendered pages.

export type Role = "owner" | "co_planner" | "member";
export type Rsvp = "in" | "maybe" | "not_yet";
export type PollKind = "dates" | "destination";
export type NudgeTopic = "rsvp" | PollKind;

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Organiser",
  co_planner: "Co-planner",
  member: "Traveller",
};

export const RSVP_OPTIONS: readonly Rsvp[] = ["in", "maybe", "not_yet"];
export const RSVP_LABELS: Record<Rsvp, string> = {
  in: "In",
  maybe: "Maybe",
  not_yet: "Not yet",
};

export const POLL_KINDS: readonly PollKind[] = ["dates", "destination"];
export const POLL_TITLES: Record<PollKind, string> = {
  dates: "Dates",
  destination: "Destination",
};

export function isRole(value: unknown): value is Role {
  return value === "owner" || value === "co_planner" || value === "member";
}
export function isRsvp(value: unknown): value is Rsvp {
  return value === "in" || value === "maybe" || value === "not_yet";
}
export function isPollKind(value: unknown): value is PollKind {
  return value === "dates" || value === "destination";
}
export function isNudgeTopic(value: unknown): value is NudgeTopic {
  return value === "rsvp" || isPollKind(value);
}

export function canPlan(role: Role): boolean {
  return role === "owner" || role === "co_planner";
}

// ---------------------------------------------------------------------------
// Data shapes (as read from the database, already scoped by RLS)
// ---------------------------------------------------------------------------

export type Member = {
  userId: string;
  name: string;
  role: Role;
  rsvp: Rsvp;
};

export type PollOption = {
  id: string;
  label: string | null;
  startDate: string | null;
  endDate: string | null;
  createdBy: string | null;
};

export type Poll = {
  id: string;
  kind: PollKind;
  status: "open" | "settled";
  settledOptionId: string | null;
  options: PollOption[];
  /** user id -> option id */
  votes: Record<string, string>;
};

export type TripBasics = {
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** "12–15 Jan 2027", "30 Jan – 2 Feb 2027", "30 Dec 2026 – 2 Jan 2027". */
export function formatDateRange(start: string, end: string): string {
  const [sy, sm, sd] = parts(start);
  const [ey, em, ed] = parts(end);
  if (sy === ey && sm === em) return `${sd}–${ed} ${MONTHS[em - 1]} ${ey}`;
  if (sy === ey) return `${sd} ${MONTHS[sm - 1]} – ${ed} ${MONTHS[em - 1]} ${ey}`;
  return `${sd} ${MONTHS[sm - 1]} ${sy} – ${ed} ${MONTHS[em - 1]} ${ey}`;
}

export function nightsBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

export function optionLabel(option: PollOption): string {
  if (option.startDate && option.endDate) {
    const nights = nightsBetween(option.startDate, option.endDate);
    return `${formatDateRange(option.startDate, option.endDate)} · ${nights} night${nights === 1 ? "" : "s"}`;
  }
  return option.label ?? "";
}

/** "A", "B", ... from a display name; "?" if it has no letters or digits. */
export function initialOf(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : "?";
}

/** Joins names as "Asha", "Asha and Ben", "Asha, Ben and 2 others". */
export function listNames(names: string[], max = 3): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - (max - 1);
  return `${names.slice(0, max - 1).join(", ")} and ${rest} others`;
}

// ---------------------------------------------------------------------------
// Poll and decision summaries
// ---------------------------------------------------------------------------

export type OptionTally = {
  option: PollOption;
  voterIds: string[];
};

export type PollSummary = {
  poll: Poll;
  tallies: OptionTally[]; // in suggestion order
  /** Option ids with the most votes (empty if nobody voted). */
  leaderIds: string[];
  votedIds: string[];
  notVotedIds: string[];
  everyoneVoted: boolean;
};

export function summarizePoll(poll: Poll, members: Member[]): PollSummary {
  const memberIds = new Set(members.map((m) => m.userId));
  const tallies = poll.options.map((option) => ({
    option,
    voterIds: Object.entries(poll.votes)
      .filter(([userId, optionId]) => optionId === option.id && memberIds.has(userId))
      .map(([userId]) => userId),
  }));
  const top = Math.max(0, ...tallies.map((t) => t.voterIds.length));
  const leaderIds = top === 0 ? [] : tallies.filter((t) => t.voterIds.length === top).map((t) => t.option.id);
  const votedIds = members.filter((m) => poll.votes[m.userId]).map((m) => m.userId);
  const notVotedIds = members.filter((m) => !poll.votes[m.userId]).map((m) => m.userId);
  return {
    poll,
    tallies,
    leaderIds,
    votedIds,
    notVotedIds,
    everyoneVoted: members.length > 0 && notVotedIds.length === 0,
  };
}

/**
 * Where a decision stands:
 *  - "decided": the vote was settled, or the trip already has the value and
 *    no vote with options is open;
 *  - "voting": an open vote has at least one option;
 *  - "empty": nothing suggested yet and nothing set on the trip.
 */
export type DecisionState = "decided" | "voting" | "empty";

export function decisionState(kind: PollKind, trip: TripBasics, poll: Poll | undefined): DecisionState {
  if (poll?.status === "settled") return "decided";
  if (poll && poll.options.length > 0) return "voting";
  const set = kind === "dates" ? Boolean(trip.startDate && trip.endDate) : Boolean(trip.destination);
  return set ? "decided" : "empty";
}

export function decidedText(kind: PollKind, trip: TripBasics): string | null {
  if (kind === "dates") {
    return trip.startDate && trip.endDate ? formatDateRange(trip.startDate, trip.endDate) : null;
  }
  return trip.destination;
}

export function rsvpCounts(members: Member[]): Record<Rsvp, number> {
  const counts: Record<Rsvp, number> = { in: 0, maybe: 0, not_yet: 0 };
  for (const m of members) counts[m.rsvp] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// The one next-step card on Trip home. Plain rules, in the PRD's Decide order
// (who is coming, dates, your private card, destination). Not AI.
// ---------------------------------------------------------------------------

export type NextStep = {
  title: string;
  detail: string;
  /** Path relative to the trip, e.g. "decide#dates" or "?tab=shape". */
  target: string;
  cta: string;
  /** Who asked you, when this step answers a nudge. */
  nudgedBy?: string;
};

/** What trip_budget_band() released: never individual numbers. */
export type BudgetBand =
  | { status: "insufficient"; respondents: number; needed: number }
  | { status: "no_overlap"; respondents: number }
  | {
      status: "band";
      respondents: number;
      low_minor: number;
      high_minor: number;
      step_minor: number;
      currency: string;
      scope: "total_per_person_incl_flights";
    };

export type NextStepInput = {
  meId: string;
  members: Member[];
  trip: TripBasics;
  polls: Partial<Record<PollKind, Poll>>;
  myCardAnswered: boolean;
  myBudgetSubmitted: boolean;
  budget: BudgetBand;
  hasPlanningBounds: boolean;
  /** Stops in the itinerary I have not voted on (PRD 05). */
  myUnvotedStops?: number;
  /** Nudges sent to me, by topic -> sender name. */
  nudges: Partial<Record<NudgeTopic, string>>;
};

export function computeNextStep(input: NextStepInput): NextStep {
  const { meId, members, trip, polls, nudges } = input;
  const me = members.find((m) => m.userId === meId);
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.name ?? "Someone";
  const planner = me ? canPlan(me.role) : false;

  // 1. Your own answers first.
  if (me && me.rsvp === "not_yet") {
    return {
      title: "Are you coming?",
      detail: "Tell the group if you're in, so plans are made around the right people.",
      target: "decide#who",
      cta: "Answer",
      nudgedBy: nudges.rsvp,
    };
  }

  for (const kind of POLL_KINDS) {
    const poll = polls[kind];
    if (decisionState(kind, trip, poll) === "voting" && poll && !poll.votes[meId]) {
      return {
        title: kind === "dates" ? "Vote on the dates" : "Vote on the destination",
        detail: `${poll.options.length} option${poll.options.length === 1 ? "" : "s"} to choose from.`,
        target: `decide#${kind}`,
        cta: "Vote",
        nudgedBy: nudges[kind],
      };
    }
    if (kind === "dates" && !input.myBudgetSubmitted) {
      return {
        title: "Add your private budget range",
        detail:
          "Total per person for the whole trip, including flights. Nobody sees your numbers, not even the organiser.",
        target: "budget",
        cta: "Add my range",
      };
    }
  }

  // 2. Nothing suggested yet: anyone can start a vote.
  for (const kind of POLL_KINDS) {
    if (decisionState(kind, trip, polls[kind]) === "empty") {
      return kind === "dates"
        ? {
            title: "Suggest some dates",
            detail: "Add one or more date ranges and the group votes on them.",
            target: "decide#dates",
            cta: "Suggest dates",
          }
        : {
            title: "Suggest a destination",
            detail: "Add places to consider and the group votes on them.",
            target: "decide#destination",
            cta: "Suggest a place",
          };
    }
  }

  // Budget ranges that do not overlap block planning for everyone.
  if (input.budget.status === "no_overlap") {
    return {
      title: "No shared budget range yet",
      detail:
        "At least one person's maximum is below someone else's minimum. Revisit your own range, or the dates or destination.",
      target: "budget",
      cta: "Review budget",
    };
  }

  // 3. Organiser / co-planner: a vote everyone has answered is ready to settle.
  if (planner) {
    for (const kind of POLL_KINDS) {
      const poll = polls[kind];
      if (poll && decisionState(kind, trip, poll) === "voting") {
        const summary = summarizePoll(poll, members);
        if (summary.everyoneVoted && summary.leaderIds.length > 0) {
          const leaders = summary.tallies
            .filter((t) => summary.leaderIds.includes(t.option.id))
            .map((t) => optionLabel(t.option));
          return {
            title: kind === "dates" ? "Everyone has voted on dates" : "Everyone has voted on the destination",
            detail:
              leaders.length === 1
                ? `Most votes: ${leaders[0]}. Settle it to lock it in.`
                : `It's a tie between ${listNames(leaders, 4)}. Pick one to settle it.`,
            target: `decide#${kind}`,
            cta: "Settle",
          };
        }
      }
    }
  }

  // 4. Waiting on other people.
  for (const kind of POLL_KINDS) {
    const poll = polls[kind];
    if (poll && decisionState(kind, trip, poll) === "voting") {
      const summary = summarizePoll(poll, members);
      if (summary.notVotedIds.length > 0) {
        const names = summary.notVotedIds.map(nameOf);
        return {
          title: `Waiting on ${names.length} ${names.length === 1 ? "person" : "people"} to vote on ${kind === "dates" ? "dates" : "the destination"}`,
          detail: `${listNames(names)} ${names.length === 1 ? "hasn't" : "haven't"} voted yet. You can send a reminder in the app.`,
          target: `decide#${kind}`,
          cta: "Nudge",
        };
      }
      return {
        title: `Waiting for ${kind === "dates" ? "the dates" : "the destination"} to be settled`,
        detail: "Everyone has voted. The organiser or a co-planner settles it.",
        target: `decide#${kind}`,
        cta: "See the vote",
      };
    }
  }

  const notAnswered = members.filter((m) => m.rsvp === "not_yet");
  if (notAnswered.length > 0) {
    const names = notAnswered.map((m) => m.name);
    return {
      title: `Waiting on ${names.length} ${names.length === 1 ? "person" : "people"} to RSVP`,
      detail: `${listNames(names)} ${names.length === 1 ? "hasn't" : "haven't"} said if they're coming.`,
      target: "decide#who",
      cta: "Nudge",
    };
  }

  // Fewer than 3 budget answers: no band can be shown, so plan within bounds
  // the group explicitly agreed.
  if (input.budget.status === "insufficient" && !input.hasPlanningBounds) {
    const needed = input.budget.needed - input.budget.respondents;
    return planner
      ? {
          title: "Record the budget bounds the group agreed",
          detail: `The private comfort zone needs ${needed} more answer${needed === 1 ? "" : "s"}. Until then, plan within bounds everyone agreed to.`,
          target: "budget",
          cta: "Record bounds",
        }
      : {
          title: "Waiting for budget answers",
          detail: `The private comfort zone needs ${needed} more answer${needed === 1 ? "" : "s"}, or bounds the group agrees.`,
          target: "budget",
          cta: "See budget",
        };
  }

  if (!input.myCardAnswered) {
    return {
      title: "Fill in your private preference card",
      detail: "Your pace, interests and must-sees. Only you can see your answers.",
      target: "preferences",
      cta: "Fill in",
    };
  }

  // 5. Decide is complete: shape the plan.
  const unvoted = input.myUnvotedStops ?? 0;
  if (unvoted > 0) {
    return {
      title: `Vote on ${unvoted} itinerary stop${unvoted === 1 ? "" : "s"}`,
      detail: "A stop is agreed once everyone is for it.",
      target: "itinerary",
      cta: "Vote",
    };
  }
  const when = decidedText("dates", trip);
  const where = decidedText("destination", trip);
  return {
    title: "Decide is done",
    detail: `${where ?? ""}${where && when ? ", " : ""}${when ?? ""}. Next: shape the plan.`,
    target: "itinerary",
    cta: "Shape the plan",
  };
}

// ---------------------------------------------------------------------------
// Input parsing for the server actions (the database checks again)
// ---------------------------------------------------------------------------

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function parseTripName(form: FormData): { ok: true; name: string } | { ok: false; error: string } {
  const name = field(form, "name");
  if (name === "") return { ok: false, error: "Give your trip a name" };
  if (name.length > 80) return { ok: false, error: "Keep the name under 80 characters" };
  return { ok: true, name };
}

export function parseDestinationOption(
  form: FormData,
): { ok: true; label: string } | { ok: false; error: string } {
  const label = field(form, "label");
  if (label === "") return { ok: false, error: "Enter a place" };
  if (label.length > 80) return { ok: false, error: "Keep it under 80 characters" };
  return { ok: true, label };
}
