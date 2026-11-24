import { describe, expect, it } from "vitest";
import {
  computeNextStep,
  decisionState,
  formatDateRange,
  initialOf,
  listNames,
  optionLabel,
  parseDestinationOption,
  parseTripName,
  summarizePoll,
  type Member,
  type NextStepInput,
  type Poll,
} from "@/lib/decide";

const A: Member = { userId: "a", name: "Asha", role: "owner", rsvp: "in" };
const B: Member = { userId: "b", name: "Ben", role: "member", rsvp: "in" };
const C: Member = { userId: "c", name: "Chitra", role: "co_planner", rsvp: "maybe" };

const datesPoll = (votes: Record<string, string> = {}, status: Poll["status"] = "open"): Poll => ({
  id: "p1",
  kind: "dates",
  status,
  settledOptionId: status === "settled" ? "o1" : null,
  options: [
    { id: "o1", label: null, startDate: "2027-01-12", endDate: "2027-01-15", createdBy: "a" },
    { id: "o2", label: null, startDate: "2027-02-01", endDate: "2027-02-04", createdBy: "b" },
  ],
  votes,
});

const destPoll = (votes: Record<string, string> = {}): Poll => ({
  id: "p2",
  kind: "destination",
  status: "open",
  settledOptionId: null,
  options: [{ id: "d1", label: "Goa", startDate: null, endDate: null, createdBy: "a" }],
  votes,
});

function input(overrides: Partial<NextStepInput> = {}): NextStepInput {
  return {
    meId: "a",
    members: [A, B, C],
    trip: { destination: null, startDate: null, endDate: null },
    polls: {},
    myCardAnswered: true,
    myBudgetSubmitted: true,
    budget: { status: "band", respondents: 3, low_minor: 2_000_000, high_minor: 2_600_000, step_minor: 100_000, currency: "INR", scope: "total_per_person_incl_flights" },
    hasPlanningBounds: false,
    nudges: {},
    ...overrides,
  };
}

describe("formatting", () => {
  it("formats date ranges compactly", () => {
    expect(formatDateRange("2027-01-12", "2027-01-15")).toBe("12–15 Jan 2027");
    expect(formatDateRange("2027-01-30", "2027-02-02")).toBe("30 Jan – 2 Feb 2027");
    expect(formatDateRange("2026-12-30", "2027-01-02")).toBe("30 Dec 2026 – 2 Jan 2027");
  });

  it("labels date options with nights", () => {
    expect(optionLabel(datesPoll().options[0])).toBe("12–15 Jan 2027 · 3 nights");
  });

  it("takes initials from names, including non-Latin ones", () => {
    expect(initialOf("asha")).toBe("A");
    expect(initialOf("  @रवि")).toBe("र");
    expect(initialOf("!!!")).toBe("?");
  });

  it("lists names naturally", () => {
    expect(listNames(["Asha"])).toBe("Asha");
    expect(listNames(["Asha", "Ben"])).toBe("Asha and Ben");
    expect(listNames(["Asha", "Ben", "Chitra"])).toBe("Asha, Ben and Chitra");
    expect(listNames(["A", "B", "C", "D", "E"])).toBe("A, B and 3 others");
  });
});

describe("summarizePoll", () => {
  it("tallies votes, finds leaders and who has not voted", () => {
    const s = summarizePoll(datesPoll({ a: "o1", b: "o1", c: "o2" }), [A, B, C]);
    expect(s.tallies.map((t) => t.voterIds.length)).toEqual([2, 1]);
    expect(s.leaderIds).toEqual(["o1"]);
    expect(s.everyoneVoted).toBe(true);
  });

  it("reports ties and no leader when nobody voted", () => {
    expect(summarizePoll(datesPoll({ a: "o1", b: "o2" }), [A, B, C]).leaderIds).toEqual(["o1", "o2"]);
    const empty = summarizePoll(datesPoll(), [A, B, C]);
    expect(empty.leaderIds).toEqual([]);
    expect(empty.notVotedIds).toEqual(["a", "b", "c"]);
  });

  it("ignores votes from people no longer on the trip", () => {
    const s = summarizePoll(datesPoll({ a: "o1", gone: "o2" }), [A, B]);
    expect(s.tallies[1].voterIds).toEqual([]);
  });
});

describe("decisionState", () => {
  const trip = { destination: null, startDate: null, endDate: null };
  it("is empty, voting or decided", () => {
    expect(decisionState("dates", trip, undefined)).toBe("empty");
    expect(decisionState("dates", trip, datesPoll())).toBe("voting");
    expect(decisionState("dates", trip, datesPoll({}, "settled"))).toBe("decided");
  });
  it("counts dates set when the trip was created as decided", () => {
    expect(
      decisionState("dates", { ...trip, startDate: "2027-01-01", endDate: "2027-01-03" }, undefined),
    ).toBe("decided");
  });
});

describe("computeNextStep", () => {
  it("asks for your own RSVP first, and says who nudged you", () => {
    const step = computeNextStep(
      input({ meId: "c", members: [A, B, { ...C, rsvp: "not_yet" }], nudges: { rsvp: "Asha" } }),
    );
    expect(step.title).toBe("Are you coming?");
    expect(step.target).toBe("decide#who");
    expect(step.nudgedBy).toBe("Asha");
  });

  it("then your vote on dates, before your budget and the destination", () => {
    const step = computeNextStep(
      input({ polls: { dates: datesPoll({ b: "o1" }), destination: destPoll() }, myBudgetSubmitted: false }),
    );
    expect(step.title).toBe("Vote on the dates");
  });

  it("then your private budget range (PRD order: who, dates, budget, destination)", () => {
    const step = computeNextStep(
      input({ polls: { dates: datesPoll({ a: "o1" }), destination: destPoll() }, myBudgetSubmitted: false }),
    );
    expect(step.target).toBe("budget");
    expect(step.detail).toMatch(/including flights/);
  });

  it("says honestly when budget ranges do not overlap", () => {
    const decided = { destination: "Goa", startDate: "2027-01-12", endDate: "2027-01-15" };
    const step = computeNextStep(input({ trip: decided, budget: { status: "no_overlap", respondents: 4 } }));
    expect(step.title).toBe("No shared budget range yet");
  });

  it("with fewer than 3 budget answers, asks planners to record agreed bounds", () => {
    const decided = { destination: "Goa", startDate: "2027-01-12", endDate: "2027-01-15" };
    const budget = { status: "insufficient" as const, respondents: 2, needed: 3 };
    expect(computeNextStep(input({ trip: decided, budget })).title).toBe("Record the budget bounds the group agreed");
    expect(computeNextStep(input({ meId: "b", trip: decided, budget })).title).toBe("Waiting for budget answers");
    expect(computeNextStep(input({ trip: decided, budget, hasPlanningBounds: true })).title).toBe("Decide is done");
  });

  it("the optional preference card comes last", () => {
    const decided = { destination: "Goa", startDate: "2027-01-12", endDate: "2027-01-15" };
    expect(computeNextStep(input({ trip: decided, myCardAnswered: false })).target).toBe("preferences");
  });

  it("suggests starting a vote when nothing is suggested yet", () => {
    expect(computeNextStep(input()).title).toBe("Suggest some dates");
    const step = computeNextStep(
      input({ trip: { destination: null, startDate: "2027-01-01", endDate: "2027-01-03" } }),
    );
    expect(step.title).toBe("Suggest a destination");
  });

  it("tells a planner to settle once everyone has voted", () => {
    const polls = { dates: datesPoll({ a: "o1", b: "o1", c: "o2" }) };
    const trip = { destination: "Goa", startDate: null, endDate: null };
    const step = computeNextStep(input({ polls, trip }));
    expect(step.title).toBe("Everyone has voted on dates");
    expect(step.detail).toContain("12–15 Jan 2027");

    // A traveller sees that it's waiting on the organiser instead.
    const traveller = computeNextStep(input({ meId: "b", polls, trip }));
    expect(traveller.title).toBe("Waiting for the dates to be settled");
  });

  it("names who the group is waiting on", () => {
    const step = computeNextStep(
      input({ polls: { dates: datesPoll({ a: "o1" }) }, trip: { destination: "Goa", startDate: null, endDate: null } }),
    );
    expect(step.title).toBe("Waiting on 2 people to vote on dates");
    expect(step.detail).toContain("Ben and Chitra");
  });

  it("waits on RSVPs, then says Decide is done", () => {
    const decided = { destination: "Goa", startDate: "2027-01-12", endDate: "2027-01-15" };
    const waiting = computeNextStep(input({ trip: decided, members: [A, { ...B, rsvp: "not_yet" }] }));
    expect(waiting.title).toBe("Waiting on 1 person to RSVP");

    const done = computeNextStep(input({ trip: decided }));
    expect(done.title).toBe("Decide is done");
    expect(done.detail).toBe("Goa, 12–15 Jan 2027. Next: shape the plan.");
    expect(done.target).toBe("?tab=shape");
  });
});

describe("input parsing", () => {
  const form = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };
  it("trip names are trimmed and limited", () => {
    expect(parseTripName(form({ name: "  Goa  " }))).toEqual({ ok: true, name: "Goa" });
    expect(parseTripName(form({ name: " " })).ok).toBe(false);
    expect(parseTripName(form({ name: "x".repeat(81) })).ok).toBe(false);
  });
  it("destination options are trimmed and limited", () => {
    expect(parseDestinationOption(form({ label: " Coorg " }))).toEqual({ ok: true, label: "Coorg" });
    expect(parseDestinationOption(form({})).ok).toBe(false);
  });
});
